import type { JobDef } from '../../jobs/types';
import { withStoreDb } from '../../jobs/store-db';
import { storeDirectory } from '@ebda/database';
import { storeFilter } from '../../jobs/store-scope';
import logger from '../../logger';
import { inngest } from '../client';
import { runReorderScan } from '../../../services/accounting/reorder-scan.service';
import { isAiEligiblePlan } from '../../ai-plan-eligibility';
import type { StorePlan } from '@ebda/shared';
import { featureService } from '../../../services/feature.service';

import { REGION } from '@ebda/shared';
/**
 * Cron-triggered reorder scan — runs every day at 06:00 Egypt time (03:00 UTC).
 *
 * For every store with accountingEnabled + aiFeaturesEnabled, calls
 * runReorderScan() which:
 *   1. Expires stale open suggestions (>30 days old).
 *   2. Computes per-product velocity + projected stock.
 *   3. Calls Gemini for bilingual reasoning on candidates.
 *   4. Upserts ReorderSuggestion rows.
 *
 * Each per-store scan is wrapped in step.run() so Inngest retries only the
 * failing store without re-running healthy ones.
 */
export const stockReorderScanCron: JobDef = inngest.createFunction(
  {
    id: 'stock-reorder-scan-cron',
    name: 'Reorder scan — daily cron (AI)',
    retries: 2,
    concurrency: { limit: 1 },
    triggers: [{ cron: `TZ=${REGION.timezone} 0 6 * * *` }], // 06:00 Cairo (DST-aware via TZ=)
  },
  async ({ event, step }) => {
    // FORCE RLS: cron has no storeId — use withRlsBypass to enumerate stores.
    // runReorderScan already calls withRlsBypass internally for its per-store reads.
    const stores = await step.run('list-stores', () =>
      // `stores` is under RLS: a cron lists stores through the directory definer.
      storeDirectory(
        s =>
          s.accountingEnabled &&
          s.aiFeaturesEnabled &&
          // free (lapsed-payment / demo) plans are excluded from AI spend.
          isAiEligiblePlan(s.plan as StorePlan)
      ).then(list => list.filter(storeFilter(event)).map(s => ({ id: s.id })))
    );

    let totalSuggested = 0;
    let totalExpired = 0;

    for (const store of stores) {
      const result = await step.run(`scan-${store.id}`, async () => {
        // Feature gate — inventory.basic, NOT inventory.purchase_orders
        // (2026-07-21). Reorder suggestions are an AI feature and fall under
        // the AI-first policy, but inventory.purchase_orders gates the whole
        // ERP purchase-order module — freeing the AI through that key would
        // hand over the module with it. Matches stock-deadstock-scan.ts, the
        // sibling AI suggestion engine, which already gates on inventory.basic.
        const enabled = await featureService.isFeatureEnabled(store.id, 'inventory.basic');
        if (!enabled) {
          logger.info(
            { storeId: store.id },
            'stock-reorder-scan: inventory.basic disabled, skipping'
          );
          return { suggested: 0, expiredCount: 0, skipped: true };
        }
        return runReorderScan(store.id);
      });
      totalSuggested += result.suggested;
      totalExpired += result.expiredCount;
    }

    logger.info(
      { stores: stores.length, totalSuggested, totalExpired },
      'stock-reorder-scan-cron completed'
    );

    return { stores: stores.length, totalSuggested, totalExpired };
  }
);

/**
 * Event-triggered on-demand reorder scan.
 *
 * Fired by the admin "Re-scan now" button (super_admin only).
 * Event: `stock/reorder-scan-requested` with data: { storeId, requestedBy? }
 */
export const stockReorderScanOnDemand: JobDef = inngest.createFunction(
  {
    id: 'stock-reorder-scan-on-demand',
    name: 'Reorder scan — on-demand (AI)',
    retries: 1,
    triggers: [{ event: 'stock/reorder-scan-requested' }],
  },
  async ({ event, step }) => {
    const { storeId, requestedBy } = event.data;

    logger.info({ storeId, requestedBy }, 'stock-reorder-scan-on-demand: starting');

    // Feature gate — inventory.basic (see the cron handler above for why this
    // is not inventory.purchase_orders).
    // One step for both gates: on a Workflow only step bodies hold a database connection.
    const { enabled, store } = await step.run('gates', async () => ({
      enabled: await featureService.isFeatureEnabled(storeId, 'inventory.basic'),
      store: await withStoreDb(storeId, db =>
        db.store.findUnique({ where: { id: storeId }, select: { plan: true } })
      ),
    }));
    if (!enabled) {
      logger.info({ storeId }, 'stock-reorder-scan-on-demand: inventory.basic disabled, skipping');
      return { skipped: true, reason: 'feature_disabled', feature: 'inventory.basic' };
    }

    // Plan gate: inventory.basic is in the `free` baseline so a lapsed merchant can still see their
    // stock; it must not buy them AI spend.
    if (!store || !isAiEligiblePlan(store.plan)) {
      logger.info(
        { storeId, plan: store?.plan },
        'stock-reorder-scan-on-demand: plan ineligible for AI, skipping'
      );
      return { skipped: true, reason: 'plan_ineligible', plan: store?.plan ?? null };
    }

    const result = await step.run(`scan-${storeId}`, () => runReorderScan(storeId));

    logger.info({ storeId, requestedBy, ...result }, 'stock-reorder-scan-on-demand completed');

    return result;
  }
);
