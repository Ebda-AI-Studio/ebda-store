import type { InngestFunction } from 'inngest';
import { runInTenantContext } from '@force/database';
import { fillProductFields, isAutopilotEnabled } from '../../../services/ai-autofill.service';
import logger from '../../logger';
import { inngest } from '../client';

/**
 * Reacts to product.upserted events and runs AI autofill on the product.
 *
 * Gated by a per-store aiAutopilot toggle (default ON) so merchants can
 * disable automated fills without touching code.
 *
 * #1937: this function used to ALSO kick the recommendations sweep on
 * `op === 'create'`. That kick now happens (post-commit) at the one true
 * creation site (`ProductService.create()` →
 * `enqueueRecommendationsSweepForNewProduct`), because this handler's
 * `debounce: { key: 'event.data.productId', period: '10s' }` delivers only
 * the LAST event in its window — a create followed by a quick edit inside
 * 10s coalesced into one `op: 'update'` delivery, silently skipping the kick
 * every time. See `enqueueRecommendationsSweepForNewProduct`'s doc comment.
 *
 * Residual, reported not fixed: `changedFields` has the same debounce-
 * coalescing gap (an earlier event's changed fields are lost if a later
 * event in the same 10s window supersedes it), so a debounced-away field
 * rename can leave a dependent AI-owned sibling field stale until the 3-day
 * stale-refresh sweep (`refreshStale`) catches it up. Forcing every debounced
 * run to `changedFields: []` would not fix this — it would regress the
 * common, NOT-coalesced single-edit case (the vast majority of saves), which
 * correctly refreshes a stale sibling today via its real `changedFields`.
 * There is no way to recover a coalesced-away event's data inside this
 * handler; the sweep already bounds the staleness window.
 *
 * Multiple functions may listen to product.upserted (e.g. product-meta-sync
 * for the Meta Catalog bot) — Inngest runs all registered listeners in
 * parallel.
 */
export const aiAutofillProduct: InngestFunction.Any = inngest.createFunction(
  {
    id: 'ai-autofill-product',
    name: 'AI-first: autofill product fields on create/update',
    concurrency: { key: 'event.data.storeId', limit: 1 },
    // A merchant saving the same product several times in a row fired one AI
    // autofill per save. Wait for the edits to settle (10s with no new save
    // for that product) and run once on the latest event.
    debounce: { key: 'event.data.productId', period: '10s' },
    retries: 2,
    triggers: [{ event: 'product.upserted' as any }],
  },
  async ({ event }) => {
    const {
      storeId,
      productId,
      op = 'update',
      changedFields = [],
    } = event.data as {
      storeId: string;
      productId: string;
      op?: 'create' | 'update';
      changedFields?: string[];
    };

    if (!storeId || !productId) return;

    await runInTenantContext(storeId, async () => {
      if (!(await isAutopilotEnabled(storeId))) {
        logger.info({ storeId, productId }, '[ai-autofill] autopilot off, skipping');
        return;
      }

      const result = await fillProductFields(storeId, productId, { op, changedFields });
      logger.info(
        { storeId, productId, op, filled: result.filled },
        '[ai-autofill] product filled'
      );
    }); // end runInTenantContext
  }
);
