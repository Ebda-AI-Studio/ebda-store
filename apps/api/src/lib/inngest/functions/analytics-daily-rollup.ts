/**
 * Analytics Daily Rollup — Accounting Batch 4 (Insights tier)
 *
 * Two Inngest functions:
 *
 *   analyticsDailyRollupCron  — nightly cron at 23:00 UTC (02:00 Kuwait, UTC+3)
 *                               runs cohort + funnel + RFM rollup for every
 *                               accountingEnabled store.
 *
 *   analyticsRollupOnDemand   — event-driven, triggered by
 *                               `insights/rollup-requested` (super_admin via
 *                               POST /:storeId/insights/rollup/run-now).
 *
 * Both delegate to `runDailyRollup()` from analytics-rollup.service.ts.
 * Each per-store step is wrapped in step.run() so Inngest retries only the
 * failing store without re-running healthy ones.
 *
 * Concurrency: limit 1 on the cron so overlapping deploys don't double-run.
 */

import type { InngestFunction } from 'inngest';
import { prisma, runInTenantContext, withRlsBypass } from '@force/database';
import logger from '../../logger';
import { inngest } from '../client';
import { runDailyRollup } from '../../../services/accounting/analytics-rollup.service';

// ---------------------------------------------------------------------------
// Nightly cron — 02:00 Kuwait (= 23:00 UTC)
// ---------------------------------------------------------------------------

export const analyticsDailyRollupCron: InngestFunction.Any = inngest.createFunction(
  {
    id: 'analytics-daily-rollup',
    name: 'Insights — nightly cohort/funnel/rfm rollup',
    retries: 2,
    concurrency: { limit: 1 },
    triggers: [{ cron: '0 23 * * *' }], // 02:00 KW = 23:00 UTC (Kuwait is UTC+3)
  },
  async ({ step }) => {
    // Cross-tenant cron — list stores with withRlsBypass so FORCE RLS on the
    // stores table does not filter to 0 rows (no tenant GUC is set).
    const stores = await step.run('list-stores', () =>
      withRlsBypass(tx =>
        tx.store.findMany({
          where: { accountingEnabled: true, deletedAt: null },
          select: { id: true },
        })
      )
    );

    const totals = { cohortRows: 0, funnelDays: 0, rfmCustomers: 0 };

    for (const store of stores) {
      // runDailyRollup uses bare prisma internally. Wrap in runInTenantContext
      // so FORCE RLS policies see the correct store GUC for all reads/writes.
      const result = await step.run(`rollup-${store.id}`, () =>
        runInTenantContext(store.id, () => runDailyRollup(store.id))
      );
      totals.cohortRows += result.cohortRows;
      totals.funnelDays += result.funnelDays;
      totals.rfmCustomers += result.rfmCustomers;
    }

    logger.info({ stores: stores.length, ...totals }, 'analytics-daily-rollup: completed');
    return { stores: stores.length, ...totals };
  }
);

// ---------------------------------------------------------------------------
// On-demand — triggered by `insights/rollup-requested` event
// ---------------------------------------------------------------------------

export const analyticsRollupOnDemand: InngestFunction.Any = inngest.createFunction(
  {
    id: 'analytics-rollup-on-demand',
    name: 'Insights — on-demand rollup',
    retries: 1,
    triggers: [{ event: 'insights/rollup-requested' }],
  },
  async ({ event, step }) => {
    const { storeId } = (event.data ?? {}) as { storeId?: string };
    if (!storeId) {
      logger.warn({ eventId: event.id }, 'analytics-rollup-on-demand: missing storeId, skipping');
      return { skipped: 'missing-storeId' };
    }

    // On-demand also runs without HTTP tenant context — wrap so FORCE RLS
    // sees the correct GUC.
    const result = await step.run('rollup', () =>
      runInTenantContext(storeId, () => runDailyRollup(storeId))
    );
    logger.info({ storeId, ...result }, 'analytics-rollup-on-demand: completed');
    return result;
  }
);
