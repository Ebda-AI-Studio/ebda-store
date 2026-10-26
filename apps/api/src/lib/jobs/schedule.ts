/**
 * Cron Triggers for jobs (G5). Inngest crons ran in UTC or in a named zone (`TZ=Africa/Cairo 0 6 * * *`);
 * Cron Triggers are UTC only. A zoned cron therefore gets TWO UTC triggers (the zone's winter and
 * summer offsets) and a guard at fire time that checks the zone's real local time, so DST (Egypt
 * has it) is always right and only one of the two runs the job. Plain UTC crons pass through
 * untouched (any 5-field expression); a zoned one needs a fixed minute and hour and `*`/number
 * elsewhere (all of the repo's zoned crons).
 */
import { allJobs } from './registry';
import { jobRunsOnCf } from './flag';
import { startJob } from './start';
import type { JobDef } from './types';
import logger from '../logger';

interface Parsed {
  tz?: string;
  min: number;
  hour: number;
  dom?: number;
  mon?: number;
  dow?: number;
}

const FIELD = /^(\*|\d+)$/;

export function parseCron(expr: string): Parsed {
  let tz: string | undefined;
  let rest = expr.trim();
  const m = /^TZ=(\S+)\s+(.*)$/.exec(rest);
  if (m) {
    tz = m[1];
    rest = m[2];
  }
  const f = rest.split(/\s+/);
  if (f.length !== 5 || !f.every(x => FIELD.test(x))) {
    throw new Error(
      `unsupported cron expression (fixed minute/hour, numeric or * fields only): ${expr}`
    );
  }
  const n = (s: string) => (s === '*' ? undefined : Number(s));
  const min = n(f[0]);
  const hour = n(f[1]);
  if (min === undefined || hour === undefined) {
    throw new Error(`cron must fix minute and hour: ${expr}`);
  }
  return { tz, min, hour, dom: n(f[2]), mon: n(f[3]), dow: n(f[4]) };
}

/** UTC offsets (hours) a zone can have; the guard picks the real one at fire time. */
const ZONE_OFFSETS: Record<string, number[]> = { 'Africa/Cairo': [2, 3] };

/** The Cron Trigger strings (UTC) a job needs. `*` sub-hourly fields (`7 * * * *`) are not supported here. */
export function utcCronsFor(expr: string): string[] {
  if (!/^TZ=/.test(expr.trim())) return [expr.trim()];
  const p = parseCron(expr);
  const offsets = p.tz ? ZONE_OFFSETS[p.tz] : undefined;
  if (!offsets) throw new Error(`no UTC offsets known for zone ${p.tz}`);
  return offsets.map(off => {
    let h = p.hour - off;
    let dow = p.dow;
    let dom = p.dom;
    if (h < 0) {
      h += 24;
      if (dow !== undefined) dow = (dow + 6) % 7;
      // The UTC trigger fires on the PREVIOUS calendar day, so a fixed day-of-month moves back one too
      // (finding M-126). The 1st would need "the last day of the previous month", which a cron field cannot say.
      if (dom !== undefined) {
        if (dom <= 1) {
          throw new Error(
            `a zoned cron on day ${dom} at local hour ${p.hour} fires on the previous UTC day: ${expr}; use hour >= ${Math.max(...offsets)}`
          );
        }
        dom -= 1;
      }
    }
    return `${p.min} ${h} ${dom ?? '*'} ${p.mon ?? '*'} ${dow ?? '*'}`;
  });
}

/** Does `at` match the zoned expression in its own zone? (UTC crons always match: the trigger IS the time.) */
export function matchesLocal(expr: string, at: Date): boolean {
  if (!/^TZ=/.test(expr.trim())) return true;
  const p = parseCron(expr);
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: p.tz,
    hourCycle: 'h23',
    hour: '2-digit',
    minute: '2-digit',
    day: 'numeric',
    month: 'numeric',
    weekday: 'short',
  }).formatToParts(at);
  const get = (t: string) => parts.find(x => x.type === t)?.value ?? '';
  const dows = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  return (
    Number(get('hour')) === p.hour &&
    Number(get('minute')) === p.min &&
    (p.dom === undefined || Number(get('day')) === p.dom) &&
    (p.mon === undefined || Number(get('month')) === p.mon) &&
    (p.dow === undefined || dows.indexOf(get('weekday')) === p.dow)
  );
}

/**
 * The id a job start carries. A UTC cron keeps the tick time. A ZONED cron is keyed by its LOCAL date and time:
 * on the night Egypt falls back, local 23:xx happens twice (once at +3, once at +2) and both UTC triggers pass
 * `matchesLocal`, which started the job twice; the same local key makes the second start a duplicate (M-126).
 */
export function tickKey(expr: string, at: Date): string {
  if (!/^TZ=/.test(expr.trim())) return String(at.getTime());
  const p = parseCron(expr);
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: p.tz,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(at);
  const get = (t: string) => parts.find(x => x.type === t)?.value ?? '';
  return `${get('year')}${get('month')}${get('day')}T${get('hour')}${get('minute')}`;
}

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
  for (const { job, expr } of scheduledJobs()) {
    if (!utcCronsFor(expr).includes(cron)) continue;
    if (!jobRunsOnCf(job.id)) continue;
    if (!matchesLocal(expr, at)) continue;
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
