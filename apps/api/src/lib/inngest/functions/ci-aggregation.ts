import type { JobDef } from '../../jobs/types';
import { storeDirectory } from '@ebda/database';
import { REGION } from '@ebda/shared';
import { cfBindings } from '../../../cf/bindings';
import { sendAlert } from '../../../services/alerts.service';
import { runCalibration } from '../../../services/ci-calibration.service';
import { saveInsights } from '../../../services/ci-insights.service';
import { generateInsights } from '../../ci/aggregate/insights';
import {
  COHORT_READ_CHUNK,
  aggregateStore,
  finalizeCohort,
  mergeAccs,
  publishCohort,
  readWindowsAcc,
  type Cohort,
  type CohortAcc,
} from '../../ci/aggregate/run';
import { METRICS } from '../../ci/aggregate/cells';
import { addDays } from '../../ci/aggregate/cells';
import type { CiBucket } from '../../ci/erase';
import { ciCohortLatestKey } from '../../ci/layout';
import logger from '../../logger';
import { inngest } from '../client';

/** A step runner: Inngest's `step.run` in the job (each step retried and memoised alone), a plain call elsewhere. */
type RunStep = <T>(id: string, fn: () => Promise<T>) => Promise<T>;
const direct: RunStep = (_id, fn) => fn();

/**
 * CI-2 (plan 3.1/3.2, Rulings CI-9 and CI-14): one daily run folds yesterday (and the day before, for a
 * late partition) into per-store day files, rebuilds each 90-day window, merges the opted-in stores into the
 * k-anonymous cohort, then records rule-based findings for a person to accept or dismiss.
 *
 * FAN-OUT (CI-14): a Worker invocation allows 1000 subrequests, and one store costs up to ~100 R2 calls, so
 * the work is NOT one handler. Each store is its own `step.run` (its own invocation, held to
 * MAX_R2_CALLS_PER_STORE), the cohort is read in chunks of COHORT_READ_CHUNK windows per step, and only the
 * small partial sums travel between steps. A store that fails is left out of the cohort and reported; the
 * next run rebuilds it. Idempotent end to end, so a step retry or a whole-run retry is safe.
 */
export async function runDailyCiAggregation(
  now = new Date(),
  ci: CiBucket | undefined = cfBindings()?.CI_BUCKET as unknown as CiBucket | undefined,
  step: RunStep = direct
) {
  if (!ci) return { skipped: true as const };
  const yesterday = addDays(now.toISOString().slice(0, 10), -1);
  const days = [addDays(yesterday, -1), yesterday];
  const stores = await step('list-stores', async () => (await storeDirectory()).map(s => s.id));

  const done: string[] = [];
  const failed: string[] = [];
  let skippedLines = 0;
  for (const storeId of stores) {
    const r = await step(`store-${storeId}`, async () => {
      try {
        return { ok: true as const, ...(await aggregateStore(ci, storeId, days)) };
      } catch (err) {
        // A store that cannot be folded must not fail (and retry) the whole run: report it, move on.
        logger.error({ err, storeId }, '[ci-agg] store aggregation failed');
        return { ok: false as const, skippedLines: 0, r2Calls: 0 };
      }
    });
    if (r.ok) done.push(storeId);
    else failed.push(storeId);
    skippedLines += r.skippedLines;
  }
  if (failed.length > 0) {
    await sendAlert({
      level: 'info',
      scope: 'platform',
      source: 'ci.aggregation_store_failed',
      title: 'Customer Intelligence aggregation skipped some stores',
      body: `${failed.length} store(s) failed this run and were left out of the cohort; the next run rebuilds them. First: ${failed[0]}`,
    }).catch(() => undefined);
  }

  const parts: CohortAcc[] = [];
  for (let i = 0; i < done.length; i += COHORT_READ_CHUNK) {
    parts.push(
      await step(`cohort-read-${i / COHORT_READ_CHUNK}`, () =>
        readWindowsAcc(ci, done.slice(i, i + COHORT_READ_CHUNK))
      )
    );
  }
  const run = await step('cohort-publish', async () => {
    const cohort = finalizeCohort(mergeAccs(parts), days.at(-1)!);
    await publishCohort(ci, cohort);
    const cells = METRICS.flatMap(m => Object.values(cohort.metrics[m]));
    return {
      cohortCells: cells.length,
      suppressedCells: cells.filter(c => 'suppressed' in c).length,
    };
  });

  const saved = await step('insights', async () => {
    const latest = await ci.get(ciCohortLatestKey);
    const cohort = latest ? (JSON.parse(await latest.text()) as Cohort) : null;
    return cohort ? await saveInsights(generateInsights(cohort)) : { created: 0, refreshed: 0 };
  });
  logger.info(
    {
      stores: done.length,
      failed: failed.length,
      skippedLines,
      cohortCells: run.cohortCells,
      suppressedCells: run.suppressedCells,
      insightsCreated: saved.created,
      insightsRefreshed: saved.refreshed,
    },
    '[ci-agg] daily run done'
  );
  return { skipped: false as const, stores: done.length, failed, skippedLines, ...run, ...saved };
}

export const ciAggregationDaily: JobDef = inngest.createFunction(
  {
    id: 'ci-aggregation-daily',
    name: 'Customer Intelligence: daily aggregates and insights',
    retries: 2,
    concurrency: { limit: 1 },
    triggers: [{ cron: `TZ=${REGION.timezone} 0 4 * * *` }], // 04:00 Cairo: yesterday UTC is complete
  },
  async ({ step }) =>
    runDailyCiAggregation(new Date(), undefined, (id, fn) => step.run(id, fn) as never)
);

/** Weekly (plan 4.3): resolve what happened to the hints shown, and close the gate of any feature that is off by > 10 points. */
export const ciHintCalibrationWeekly: JobDef = inngest.createFunction(
  {
    id: 'ci-hint-calibration-weekly',
    name: 'Customer Intelligence: weekly hint calibration',
    retries: 2,
    concurrency: { limit: 1 },
    triggers: [{ cron: `TZ=${REGION.timezone} 30 4 * * 1` }], // Mondays, Cairo (digits are mapped to names by jobs/cron-expr.ts)
  },
  async ({ event }) => {
    const r = await runCalibration(undefined, event);
    return { alerted: r.alerted, bands: r.results.length };
  }
);
