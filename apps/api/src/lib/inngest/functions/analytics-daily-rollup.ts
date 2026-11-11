/**
 * Analytics Daily Rollup — Accounting Batch 4 (Insights tier)
 *
 * Two Inngest functions:
 *
 *   analyticsDailyRollupCron  — nightly cron at 02:00 Cairo (`TZ=` cron, DST-aware).
 *                               Lists the accountingEnabled stores and FANS OUT
 *                               one `insights/rollup-requested` event per store
 *                               (issue 2348) — it does no rollup work itself.
 *
 *   analyticsRollupOnDemand   — event-driven, triggered by
 *                               `insights/rollup-requested` (the cron's fan-out,
 *                               or a super_admin via
 *                               POST /:storeId/insights/rollup/run-now).
 *
 * The per-store run executes the three rollups via `runStoreRollupSteps` — one
 * step and one tenant transaction per rollup — so Inngest retries only the
 * failing rollup without re-running healthy ones (issue 2293).
 *
 * Step cost (issue 2348): the nightly total is 1 + ceil(N/500) steps on the
 * cron + 3 per store (3N) in N separate runs. The old shape ran all 3N+1 steps
 * inside ONE run, so the run's step count — and its wall-clock, serialised by
 * `concurrency: 1` — grew without a ceiling as stores were added. Each run is
 * now bounded (3 steps), and the per-store runs are capped at 3 at a time with
 * one per store, so the DB sees at most 3 rollups at once.
 *
 */

import type { JobDef } from '../../jobs/types';
import { storeDirectory } from '@ebda/database';
import { runInStoreCtx } from '../../jobs/store-db';
import { storeFilter } from '../../jobs/store-scope';
import { isStoreGoneError } from '../../jobs/store-gone';
import { storeRepo } from '../../repo-factory';
import logger from '../../logger';
import { inngest } from '../client';
import {
  runCohortRollup,
  runFunnelRollup,
  runRfmRollup,
  type RollupResult,
} from '../../../services/accounting/analytics-rollup.service';

import { REGION } from '@ebda/shared';
interface RollupStep {
  run<T>(id: string, fn: () => Promise<T>): Promise<T>;
}

/**
 * One store's three rollups, each in its OWN step and its own tenant
 * transaction (issue 2293). They used to share one `runInTenantContext`
 * (30s hard timeout): a long RFM pass timed out the transaction and took
 * the cohort and funnel writes down with it — the all-or-nothing failure
 * the per-row savepoints were added to prevent — and a retry re-ran all
 * three. Now each has the full budget and a retry re-runs only the one that
 * failed.
 */
export async function runStoreRollupSteps(
  step: RollupStep,
  storeId: string,
  prefix: string
): Promise<RollupResult> {
  const cohortRows = await step.run(`${prefix}-cohort`, () =>
    runInStoreCtx(storeId, () => runCohortRollup(storeId))
  );
  const funnelDays = await step.run(`${prefix}-funnel`, () =>
    runInStoreCtx(storeId, () => runFunnelRollup(storeId))
  );
  const rfmCustomers = await step.run(`${prefix}-rfm`, () =>
    runInStoreCtx(storeId, () => runRfmRollup(storeId))
  );
  return { cohortRows, funnelDays, rfmCustomers };
}

// ---------------------------------------------------------------------------
// Nightly cron — 02:00 Egypt (= 23:00 UTC)
// ---------------------------------------------------------------------------

/** Events per `step.sendEvent` call — keeps each request well under Inngest's payload limit. */
export const FANOUT_BATCH = 500;

export const analyticsDailyRollupCron: JobDef = inngest.createFunction(
  {
    id: 'analytics-daily-rollup',
    name: 'Insights — nightly cohort/funnel/rfm rollup',
    retries: 2,
    concurrency: { limit: 1 },
    triggers: [{ cron: `TZ=${REGION.timezone} 0 2 * * *` }], // 02:00 Cairo (DST-aware via TZ=)
  },
  async ({ event, step }) => {
    // Cross-tenant cron — list stores with withRlsBypass so FORCE RLS on the
    // stores table does not filter to 0 rows (no tenant GUC is set). Ids only.
    const stores = await step.run('list-stores', () =>
      // `stores` is under RLS: a cron lists stores through the directory definer (id order).
      storeDirectory(storeFilter(event, s => s.accountingEnabled)).then(list =>
        list.map(s => ({ id: s.id }))
      )
    );

    // One event per store, sent in bounded batches: the per-store work runs in
    // its own function run (analyticsRollupOnDemand), never inside this one.
    for (let i = 0; i < stores.length; i += FANOUT_BATCH) {
      const batch = stores.slice(i, i + FANOUT_BATCH);
      await step.sendEvent(
        `fan-out-${i / FANOUT_BATCH}`,
        batch.map((s: { id: string }) => ({
          name: 'insights/rollup-requested' as const,
          data: { storeId: s.id, requestedBy: 'nightly-cron' },
        }))
      );
    }

    logger.info({ stores: stores.length }, 'analytics-daily-rollup: fanned out');
    return { stores: stores.length };
  }
);

// ---------------------------------------------------------------------------
// On-demand — triggered by `insights/rollup-requested` event
// ---------------------------------------------------------------------------

export const analyticsRollupOnDemand: JobDef = inngest.createFunction(
  {
    id: 'analytics-rollup-on-demand',
    name: 'Insights — per-store rollup (nightly fan-out + on-demand)',
    // 2, as the cron had when it ran the rollups inline — the nightly work now
    // lands here.
    retries: 2,
    // At most 3 stores' rollups at once (DB pool), and never two for one store
    // (a super_admin "run now" during the nightly fan-out queues behind it).
    concurrency: [{ limit: 3 }, { key: 'event.data.storeId', limit: 1 }],
    triggers: [{ event: 'insights/rollup-requested' }],
  },
  async ({ event, step }) => {
    const { storeId } = (event.data ?? {}) as { storeId?: string };
    if (!storeId) {
      logger.warn({ eventId: event.id }, 'analytics-rollup-on-demand: missing storeId, skipping');
      return { skipped: 'missing-storeId' };
    }

    // A store deleted (or its storage removed) between the fan-out and this run, or a super_admin "run now" on one, can
    // never come back: skip it instead of failing three retries (gone-store class). Any other error still throws.
    const live = await step.run('store-live', async () => {
      try {
        await storeRepo(storeId);
        return true;
      } catch (err) {
        if (isStoreGoneError(err)) return false;
        throw err;
      }
    });
    if (!live) {
      logger.warn({ storeId }, 'analytics-rollup-on-demand: store is gone, skipping');
      return { skipped: 'store-gone' };
    }

    // On-demand also runs without HTTP tenant context — wrap so FORCE RLS
    // sees the correct GUC.
    const result = await runStoreRollupSteps(step, storeId, 'rollup');
    logger.info({ storeId, ...result }, 'analytics-rollup-on-demand: completed');
    return result;
  }
);
