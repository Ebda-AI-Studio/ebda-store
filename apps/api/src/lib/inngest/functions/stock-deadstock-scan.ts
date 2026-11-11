import type { JobDef } from '../../jobs/types';
import { withStoreDb } from '../../jobs/store-db';
import { storeDirectory } from '@ebda/database';
import { storeFilter } from '../../jobs/store-scope';
import logger from '../../logger';
import { inngest } from '../client';
import { runDeadstockScan } from '../../../services/accounting/deadstock-scan.service';
import { isAiEligiblePlan } from '../../ai-plan-eligibility';
import type { StorePlan } from '@ebda/shared';
import { featureService } from '../../../services/feature.service';

import { REGION } from '@ebda/shared';
/**
 * Cron-triggered dead-stock scan — runs every Sunday at 06:00 Egypt time (03:00 UTC).
 *
 * For every store with accountingEnabled + aiFeaturesEnabled, calls
 * runDeadstockScan() which:
 *   1. Expires stale open flags (>30 days old).
 *   2. Evaluates each active trackInventory product against the dead-stock criteria
 *      (daysSinceSale >= 90 AND (stockValueFils >= 50,000 OR no cost price → value unknown)).
 *      A never-sold product is aged from its createdAt, not flagged on day one.
 *   3. Calls Gemini for bilingual clearance copy on candidates.
 *   4. Upserts DeadStockFlag rows.
 *
 * Each per-store scan is wrapped in step.run() so Inngest retries only the
 * failing store without re-running healthy ones.
 */
export const stockDeadstockScanCron: JobDef = inngest.createFunction(
  {
    id: 'stock-deadstock-scan-cron',
    name: 'Dead-stock scan — weekly cron (AI)',
    retries: 2,
    concurrency: { limit: 1 },
    triggers: [{ cron: `TZ=${REGION.timezone} 0 6 * * 0` }], // Sunday 06:00 Cairo (DST-aware via TZ=)
  },
  async ({ event, step }) => {
    // Cross-tenant cron — list stores with withRlsBypass so FORCE RLS on the
    // stores table does not filter to 0 rows (no tenant GUC is set).
    // runDeadstockScan() already wraps its own DB work in withRlsBypass.
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

    // Stores to visit: entitlement read in one batched prefetch per run (selection only). The per-store gate below stays a
    // LIVE read, so a downgrade mid-run is still honoured before any paid action (entitlements are NEVER-stale).
    const enabledIds = new Set(
      await step.run('select-enabled-stores', () =>
        featureService.selectEnabled(
          stores.map(s => s.id),
          'inventory.basic'
        )
      )
    );

    let totalFlagged = 0;
    let totalExpired = 0;

    for (const store of stores.filter(s => enabledIds.has(s.id))) {
      const result = await step.run(`scan-${store.id}`, async () => {
        // Feature gate — dead-stock analysis requires inventory.basic.
        const enabled = await featureService.isFeatureEnabled(store.id, 'inventory.basic');
        if (!enabled) {
          logger.info(
            { storeId: store.id },
            'stock-deadstock-scan: inventory.basic disabled, skipping'
          );
          return { flagged: 0, expiredCount: 0, skipped: true };
        }
        return runDeadstockScan(store.id);
      });
      totalFlagged += result.flagged;
      totalExpired += result.expiredCount;
    }

    logger.info(
      { stores: stores.length, totalFlagged, totalExpired },
      'stock-deadstock-scan-cron completed'
    );

    return { stores: stores.length, totalFlagged, totalExpired };
  }
);

/**
 * Event-triggered on-demand dead-stock scan.
 *
 * Fired by the admin "Re-scan now" button (super_admin only).
 * Event: `stock/deadstock-scan-requested` with data: { storeId, requestedBy? }
 */
export const stockDeadstockScanOnDemand: JobDef = inngest.createFunction(
  {
    id: 'stock-deadstock-scan-on-demand',
    name: 'Dead-stock scan — on-demand (AI)',
    retries: 1,
    triggers: [{ event: 'stock/deadstock-scan-requested' }],
  },
  async ({ event, step }) => {
    const { storeId, requestedBy } = event.data;

    logger.info({ storeId, requestedBy }, 'stock-deadstock-scan-on-demand: starting');

    // Feature gate — skip when inventory.basic is disabled.
    // One step for both gates: on a Workflow only step bodies hold a database connection.
    const { enabled, store } = await step.run('gates', async () => ({
      enabled: await featureService.isFeatureEnabled(storeId, 'inventory.basic'),
      store: await withStoreDb(storeId, db =>
        db.store.findUnique({ where: { id: storeId }, select: { plan: true } })
      ),
    }));
    if (!enabled) {
      logger.info(
        { storeId },
        'stock-deadstock-scan-on-demand: inventory.basic disabled, skipping'
      );
      return { skipped: true, reason: 'feature_disabled', feature: 'inventory.basic' };
    }

    // Plan gate: inventory.basic is in the `free` baseline so a lapsed merchant can still see their
    // stock; it must not buy them AI spend.
    if (!store || !isAiEligiblePlan(store.plan)) {
      logger.info(
        { storeId, plan: store?.plan },
        'stock-deadstock-scan-on-demand: plan ineligible for AI, skipping'
      );
      return { skipped: true, reason: 'plan_ineligible', plan: store?.plan ?? null };
    }

    const result = await step.run(`scan-${storeId}`, () => runDeadstockScan(storeId));

    logger.info({ storeId, requestedBy, ...result }, 'stock-deadstock-scan-on-demand completed');

    return result;
  }
);
