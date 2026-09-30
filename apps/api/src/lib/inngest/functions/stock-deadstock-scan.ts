import type { InngestFunction } from 'inngest';
import { withRlsBypass } from '@force/database';
import logger from '../../logger';
import { inngest } from '../client';
import { runDeadstockScan } from '../../../services/accounting/deadstock-scan.service';
import { aiEligiblePlanFilter, isAiEligiblePlan } from '../../ai-plan-eligibility';
import { featureService } from '../../../services/feature.service';

/**
 * Cron-triggered dead-stock scan — runs every Sunday at 06:00 Kuwait time (03:00 UTC).
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
export const stockDeadstockScanCron: InngestFunction.Any = inngest.createFunction(
  {
    id: 'stock-deadstock-scan-cron',
    name: 'Dead-stock scan — weekly cron (AI)',
    retries: 2,
    concurrency: { limit: 1 },
    triggers: [{ cron: '0 3 * * 0' }], // Sunday 06:00 KW = Sunday 03:00 UTC (Kuwait is UTC+3)
  },
  async ({ step }) => {
    // Cross-tenant cron — list stores with withRlsBypass so FORCE RLS on the
    // stores table does not filter to 0 rows (no tenant GUC is set).
    // runDeadstockScan() already wraps its own DB work in withRlsBypass.
    const stores = await step.run('list-stores', () =>
      withRlsBypass(tx =>
        tx.store.findMany({
          where: {
            accountingEnabled: true,
            aiFeaturesEnabled: true,
            deletedAt: null,
            // free (lapsed-payment / demo) plans are excluded from AI spend.
            ...aiEligiblePlanFilter,
          },
          select: { id: true },
        })
      )
    );

    let totalFlagged = 0;
    let totalExpired = 0;

    for (const store of stores) {
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
export const stockDeadstockScanOnDemand: InngestFunction.Any = inngest.createFunction(
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
    const enabled = await featureService.isFeatureEnabled(storeId, 'inventory.basic');
    if (!enabled) {
      logger.info(
        { storeId },
        'stock-deadstock-scan-on-demand: inventory.basic disabled, skipping'
      );
      return { skipped: true, reason: 'feature_disabled', feature: 'inventory.basic' };
    }

    // Plan gate — inventory.basic is in the `free` baseline so a lapsed
    // merchant can still see their stock; it must not buy them AI spend.
    const store = await withRlsBypass(tx =>
      tx.store.findUnique({ where: { id: storeId }, select: { plan: true } })
    );
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
