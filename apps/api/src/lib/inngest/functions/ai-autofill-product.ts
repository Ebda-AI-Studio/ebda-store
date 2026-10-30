import type { JobDef } from '../../jobs/types';
import { runInStoreScope } from '@ebda/database';
import { runInStoreCtx } from '../../jobs/store-db';
import {
  applyFill,
  generateFill,
  isAutopilotEnabled,
  readFillPlan,
  type FillGeneration,
  type FillPlan,
} from '../../../services/ai-autofill.service';
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
 * rename can leave a dependent AI-owned sibling field stale until the daily
 * stale-refresh sweep (`refreshStale`) catches it up. Forcing every debounced
 * run to `changedFields: []` would not fix this — it would regress the
 * common, NOT-coalesced single-edit case (the vast majority of saves), which
 * correctly refreshes a stale sibling today via its real `changedFields`.
 * There is no way to recover a coalesced-away event's data inside this
 * handler; the sweep already bounds the staleness window.
 *
 * Review I2 (Task 8): three memoized steps, never one transaction around the AI.
 *   1. `read`     — one short tenant transaction (autopilot flag + the fill plan).
 *   2. `generate` — `runInStoreScope`: every AI call happens OUTSIDE a transaction; quota checks,
 *                   cache reads and usage rows are each their own short statement. The output is
 *                   memoized by Inngest, so a retry of a later step never pays Gemini again.
 *   3. `write`    — one short guarded transaction (`applyFill`: row lock, re-read, per-field
 *                   merge — a merchant edit made meanwhile wins, review I1). Idempotent.
 * It used to run the whole fill inside ONE 30 s `runInTenantContext` transaction: a slow or
 * failing-over Gemini rolled back every write AND every usage row, and each retry re-billed.
 *
 * Multiple functions may listen to product.upserted — Inngest runs all
 * registered listeners in parallel.
 */
interface AutofillEvent {
  data: {
    storeId?: string;
    productId?: string;
    op?: 'create' | 'update';
    changedFields?: string[];
  };
}
interface AutofillStep {
  run<T>(name: string, fn: () => Promise<T>): Promise<unknown>;
}

/** The function body, exported for tests (a fake `step` memoizes like Inngest). */
export async function handleAiAutofillProduct({
  event,
  step,
}: {
  event: AutofillEvent;
  step: AutofillStep;
}): Promise<void> {
  const { storeId, productId, op = 'update', changedFields = [] } = event.data;
  if (!storeId || !productId) return;

  const plan = (await step.run('read', () =>
    runInStoreCtx(storeId, async () => {
      if (!(await isAutopilotEnabled(storeId))) {
        logger.info({ storeId, productId }, '[ai-autofill] autopilot off, skipping');
        return null;
      }
      return readFillPlan(storeId, productId, { op, changedFields });
    })
  )) as FillPlan | null;
  if (!plan) return;

  const gen = (await step.run('generate', () =>
    runInStoreScope(storeId, () => generateFill(plan))
  )) as FillGeneration;

  const { filled } = (await step.run('write', () =>
    runInStoreScope(storeId, () => applyFill(plan, gen))
  )) as { filled: number };
  logger.info({ storeId, productId, op, filled, calls: gen.calls }, '[ai-autofill] product filled');
}

export const aiAutofillProduct: JobDef = inngest.createFunction(
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
  async ({ event, step }) =>
    handleAiAutofillProduct({ event: event as AutofillEvent, step: step as AutofillStep })
);
