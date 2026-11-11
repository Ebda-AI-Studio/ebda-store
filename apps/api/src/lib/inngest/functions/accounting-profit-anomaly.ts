import type { JobDef } from '../../jobs/types';
import { storeDirectory } from '@ebda/database';
import { runInStoreCtx } from '../../jobs/store-db';
import { storeFilter } from '../../jobs/store-scope';
import logger from '../../logger';
import { inngest } from '../client';
import { runProfitAnomalyScan } from '../../../services/accounting/profit-anomaly.service';
import { featureService } from '../../../services/feature.service';

import { REGION } from '@ebda/shared';
/**
 * Daily profit anomaly scan — runs at 06:30 Egypt time (03:30 UTC).
 *
 * For every store with accountingEnabled + aiFeaturesEnabled, calls
 * runProfitAnomalyScan() which:
 *   1. Computes 7d vs 28d metrics (margin, cost, revenue, refunds).
 *   2. Calls Gemini for bilingual explanations on any anomaly.
 *   3. Writes ProfitAnomaly rows.
 *   4. Fires a P0 Telegram alert when severity='p0' and no alert was
 *      sent for the same metric in the last 24h.
 *
 * Each per-store scan is wrapped in step.run() so Inngest retries only
 * the failing store without re-running healthy ones.
 */
export const accountingProfitAnomalyCron: JobDef = inngest.createFunction(
  {
    id: 'accounting-profit-anomaly-cron',
    name: 'Profit anomaly scan — daily cron (AI)',
    retries: 2,
    concurrency: { limit: 1 },
    triggers: [{ cron: `TZ=${REGION.timezone} 30 6 * * *` }], // 06:30 Cairo (DST-aware via TZ=)
  },
  async ({ event, step }) => {
    // Cross-tenant cron — list stores with withRlsBypass so FORCE RLS on the
    // stores table does not filter to 0 rows (no tenant GUC is set).
    const stores = await step.run('list-stores', () =>
      // `stores` is under RLS: a cron lists stores through the directory definer.
      storeDirectory(storeFilter(event, s => s.accountingEnabled && s.aiFeaturesEnabled)).then(
        list => list.map(s => ({ id: s.id }))
      )
    );

    // Entitlements for the whole sweep in 3 batched reads (per run only, never cached across runs; Sentry N+1).
    await step.run('prefetch-features', async () => {
      await featureService.prefetchStoreFeatures(stores.map(s => s.id));
      return true; // a step result must be JSON-safe
    });

    let totalDetected = 0;
    let totalP0 = 0;

    for (const store of stores) {
      const result = await step.run(`anomaly-${store.id}`, async () => {
        // Feature gate — skip stores without accounting.profit_anomaly enabled.
        const enabled = await featureService.isFeatureEnabled(
          store.id,
          'accounting.profit_anomaly'
        );
        if (!enabled) {
          logger.info(
            { storeId: store.id },
            'accounting-profit-anomaly: feature disabled, skipping'
          );
          return { detected: 0, p0Count: 0, skipped: true };
        }
        // runProfitAnomalyScan uses bare prisma internally. Wrap in
        // runInTenantContext so FORCE RLS sees the correct store GUC and
        // reads/writes go to the right tenant rows.
        return runInStoreCtx(store.id, () => runProfitAnomalyScan(store.id));
      });
      totalDetected += result.detected;
      totalP0 += result.p0Count;
    }

    logger.info(
      { stores: stores.length, totalDetected, totalP0 },
      'accounting-profit-anomaly-cron completed'
    );

    return { stores: stores.length, totalDetected, totalP0 };
  }
);
