/**
 * Cron expression math shared by the Cron Trigger path (schedule.ts) and the DO alarm path
 * (next-run.ts). Pure: no imports, so it loads anywhere (Worker, tests, a Durable Object).
 * Inngest crons ran in UTC or in a named zone (`TZ=Africa/Cairo 0 6 * * *`); Cron Triggers are UTC
 * only. A zoned cron therefore gets TWO UTC triggers (the zone's winter and summer offsets) and a
 * guard at fire time that checks the zone's real local time, so DST (Egypt has it) is always right
 * and only one of the two runs the job. Plain UTC crons pass through untouched (any 5-field
 * expression); a zoned one needs a fixed minute and hour and `*`/number elsewhere (all of the
 * repo's zoned crons).
 */
export interface Parsed {
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

const DOW_NAMES = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];

/**
 * Cloudflare Cron Triggers number the weekday 1-7 with 1 = Sunday and REJECT 0 ("invalid cron string:
 * 0 3 * * 0", code 10100 on the schedules PUT: the cause of every failed API deploy since #210). A
 * numeric `1` is accepted but means Sunday there, not Monday. Standard cron numbers (0/7 = Sunday)
 * are therefore always written as names, which mean the same everywhere.
 */
export function cfWeekday(field: string): string {
  const name = (t: string): string => (/^\d+$/.test(t) ? (DOW_NAMES[Number(t) % 7] ?? t) : t);
  return field
    .split(',')
    .map(part => {
      const m = /^([^/]+)(\/.*)?$/.exec(part);
      if (!m || m[1] === '*') return part;
      return m[1].split('-').map(name).join('-') + (m[2] ?? '');
    })
    .join(',');
}

function withCfWeekday(cron: string): string {
  const f = cron.trim().split(/\s+/);
  if (f.length === 5) f[4] = cfWeekday(f[4]);
  return f.join(' ');
}

/** The Cron Trigger strings (UTC) a job needs. `*` sub-hourly fields (`7 * * * *`) are not supported here. */
export function utcCronsFor(expr: string): string[] {
  if (!/^TZ=/.test(expr.trim())) return [withCfWeekday(expr)];
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
    return withCfWeekday(`${p.min} ${h} ${dom ?? '*'} ${p.mon ?? '*'} ${dow ?? '*'}`);
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
