import type { InngestFunction } from 'inngest';
import { prisma } from '@force/database';
import logger from '../../logger';
import { inngest } from '../client';
import { runDeadstockScan } from '../../../services/accounting/deadstock-scan.service';

/**
 * Cron-triggered dead-stock scan — runs every Sunday at 06:00 Kuwait time (03:00 UTC).
 *
 * For every store with accountingEnabled + aiFeaturesEnabled, calls
 * runDeadstockScan() which:
 *   1. Expires stale open flags (>30 days old).
 *   2. Evaluates each active trackInventory product against the dead-stock criteria
 *      (daysSinceSale >= 90 AND stockValueFils >= 50,000).
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
    const stores = await step.run('list-stores', () =>
      prisma.store.findMany({
        where: { accountingEnabled: true, aiFeaturesEnabled: true, deletedAt: null },
        select: { id: true },
      })
    );

    let totalFlagged = 0;
    let totalExpired = 0;

    for (const store of stores) {
      const result = await step.run(`scan-${store.id}`, () => runDeadstockScan(store.id));
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

    const result = await step.run(`scan-${storeId}`, () => runDeadstockScan(storeId));

    logger.info({ storeId, requestedBy, ...result }, 'stock-deadstock-scan-on-demand completed');

    return result;
  }
);
