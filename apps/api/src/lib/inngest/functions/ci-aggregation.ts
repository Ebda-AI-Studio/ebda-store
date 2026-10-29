import type { JobDef } from '../../jobs/types';
import { storeDirectory } from '@ebda/database';
import { REGION } from '@ebda/shared';
import { cfBindings } from '../../../cf/bindings';
import { sendAlert } from '../../../services/alerts.service';
import { runCalibration } from '../../../services/ci-calibration.service';
import { saveInsights } from '../../../services/ci-insights.service';
import { generateInsights } from '../../ci/aggregate/insights';
import { runCiAggregation, type Cohort } from '../../ci/aggregate/run';
import { addDays } from '../../ci/aggregate/cells';
import type { CiBucket } from '../../ci/erase';
import { ciCohortLatestKey } from '../../ci/layout';
import logger from '../../logger';
import { inngest } from '../client';

/**
 * CI-2 (plan 3.1/3.2, Ruling CI-9): one daily run folds yesterday (and the day before, for a late
 * partition) into per-store day files, rebuilds each 90-day window, merges the opted-in stores into the
 * k-anonymous cohort, then records rule-based findings for a person to accept or dismiss. One run a day,
 * no per-event jobs; idempotent end to end, so a retry of the whole handler is safe.
 */
export async function runDailyCiAggregation(
  now = new Date(),
  ci: CiBucket | undefined = cfBindings()?.CI_BUCKET as unknown as CiBucket | undefined
) {
  if (!ci) return { skipped: true as const };
  const yesterday = addDays(now.toISOString().slice(0, 10), -1);
  const stores = (await storeDirectory()).map(s => s.id);
  const run = await runCiAggregation(ci, stores, [addDays(yesterday, -1), yesterday]);
  if (run.failed.length > 0) {
    await sendAlert({
      level: 'info',
      scope: 'platform',
      source: 'ci.aggregation_store_failed',
      title: 'Customer Intelligence aggregation skipped some stores',
      body: `${run.failed.length} store(s) failed this run and were left out of the cohort; the next run rebuilds them. First: ${run.failed[0]}`,
    }).catch(() => undefined);
  }
  const latest = await ci.get(ciCohortLatestKey);
  const cohort = latest ? (JSON.parse(await latest.text()) as Cohort) : null;
  const saved = cohort
    ? await saveInsights(generateInsights(cohort))
    : { created: 0, refreshed: 0 };
  logger.info({ ...run, ...saved }, '[ci-agg] daily run done');
  return { skipped: false as const, ...run, ...saved };
}

export const ciAggregationDaily: JobDef = inngest.createFunction(
  {
    id: 'ci-aggregation-daily',
    name: 'Customer Intelligence: daily aggregates and insights',
    retries: 2,
    concurrency: { limit: 1 },
    triggers: [{ cron: `TZ=${REGION.timezone} 0 4 * * *` }], // 04:00 Cairo: yesterday UTC is complete
  },
  async () => runDailyCiAggregation()
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
  async () => {
    const r = await runCalibration();
    return { alerted: r.alerted, bands: r.results.length };
  }
);
