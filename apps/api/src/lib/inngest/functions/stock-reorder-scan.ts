import type { InngestFunction } from 'inngest';
import { prisma } from '@force/database';
import logger from '../../logger';
import { inngest } from '../client';
import { runReorderScan } from '../../../services/accounting/reorder-scan.service';

/**
 * Cron-triggered reorder scan — runs every day at 06:00 Kuwait time (03:00 UTC).
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
export const stockReorderScanCron: InngestFunction.Any = inngest.createFunction(
  {
    id: 'stock-reorder-scan-cron',
    name: 'Reorder scan — daily cron (AI)',
    retries: 2,
    concurrency: { limit: 1 },
    triggers: [{ cron: '0 3 * * *' }], // 06:00 KW = 03:00 UTC (Kuwait is UTC+3)
  },
  async ({ step }) => {
    const stores = await step.run('list-stores', () =>
      prisma.store.findMany({
        where: { accountingEnabled: true, aiFeaturesEnabled: true, deletedAt: null },
        select: { id: true },
      })
    );

    let totalSuggested = 0;
    let totalExpired = 0;

    for (const store of stores) {
      const result = await step.run(`scan-${store.id}`, () => runReorderScan(store.id));
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
export const stockReorderScanOnDemand: InngestFunction.Any = inngest.createFunction(
  {
    id: 'stock-reorder-scan-on-demand',
    name: 'Reorder scan — on-demand (AI)',
    retries: 1,
    triggers: [{ event: 'stock/reorder-scan-requested' }],
  },
  async ({ event, step }) => {
    const { storeId, requestedBy } = event.data;

    logger.info({ storeId, requestedBy }, 'stock-reorder-scan-on-demand: starting');

    const result = await step.run(`scan-${storeId}`, () => runReorderScan(storeId));

    logger.info({ storeId, requestedBy, ...result }, 'stock-reorder-scan-on-demand completed');

    return result;
  }
);
