/**
 * Cron Triggers for jobs (G5). Inngest crons ran in UTC or in a named zone (`TZ=Africa/Cairo 0 6 * * *`);
 * Cron Triggers are UTC only. A zoned cron therefore gets TWO UTC triggers (the zone's winter and
 * summer offsets) and a guard at fire time that checks the zone's real local time, so DST (Egypt
 * has it) is always right and only one of the two runs the job. Plain UTC crons pass through
 * untouched (any 5-field expression); a zoned one needs a fixed minute and hour and `*`/number
 * elsewhere (all of the repo's zoned crons).
 */
import { allJobs } from './registry';
import { matchesLocal, parseCron, tickKey, utcCronsFor } from './cron-expr';

export { matchesLocal, parseCron, tickKey, utcCronsFor };
import { jobRunsOnCf } from './flag';
import { isSweepCron, writesFrozen } from './freeze';
import { startJob } from './start';
import type { JobDef } from './types';
import logger from '../logger';

export interface ScheduledJob {
  job: JobDef;
  expr: string;
}

export function scheduledJobs(): ScheduledJob[] {
  return allJobs().flatMap(job =>
    (job.options.triggers ?? []).flatMap(t => (t.cron ? [{ job, expr: t.cron }] : []))
  );
}

/** Every distinct UTC cron string the jobs need (wrangler.jsonc `triggers.crons` must contain them). */
export function allJobCronStrings(): string[] {
  return [...new Set(scheduledJobs().flatMap(s => utcCronsFor(s.expr)))].sort();
}

/**
 * A Cron Trigger fired: start every job on Cloudflare that is scheduled for this UTC string and
 * whose zone-local time matches. The synthetic event id is stable per job and tick, so a
 * double-delivered trigger starts one instance.
 */
export async function runScheduledJobs(
  cron: string,
  scheduledTime: number
): Promise<Array<{ job: string; result: string }>> {
  const at = new Date(scheduledTime);
  const out: Array<{ job: string; result: string }> = [];
  const frozen = writesFrozen();
  for (const { job, expr } of scheduledJobs()) {
    if (!utcCronsFor(expr).includes(cron)) continue;
    if (!jobRunsOnCf(job.id)) continue;
    // An alarm-ready job also fires per DO store from StoreSchedule alarms (cf/store-schedule.ts). The cron keeps serving the
    // Postgres stores: lib/jobs/do-guard.ts hides the DO stores from its sweep, so no store runs twice (Ruling CF-JOBS-1).
    if (!matchesLocal(expr, at)) continue;
    // Write freeze (Ruling CF-JOBS-2): a sweep's next tick after the window catches up; a rarer job is STARTED and parked
    // by the run layer (queue re-send / Workflow sleep), never dropped.
    if (frozen && isSweepCron(expr, scheduledTime)) {
      logger.warn({ job: job.id, cron }, '[jobs] write freeze: sweep tick skipped');
      out.push({ job: job.id, result: 'frozen-skipped' });
      continue;
    }
    try {
      const result = await startJob(job, {
        id: `cron-${job.id}-${tickKey(expr, at)}`,
        name: 'inngest/scheduled.timer',
        data: { cron: expr },
        ts: scheduledTime,
      });
      out.push({ job: job.id, result });
    } catch (err) {
      // One failing start never stops the others; the next tick of an hourly sweep retries.
      logger.error({ err, job: job.id, cron }, '[jobs] scheduled start failed');
      out.push({ job: job.id, result: 'failed' });
    }
  }
  return out;
}
