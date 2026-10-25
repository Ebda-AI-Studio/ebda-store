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

/** The Cron Trigger strings (UTC) a job needs. `*` sub-hourly fields (`7 * * * *`) are not supported here. */
export function utcCronsFor(expr: string): string[] {
  if (!/^TZ=/.test(expr.trim())) return [expr.trim()];
  const p = parseCron(expr);
  const offsets = p.tz ? ZONE_OFFSETS[p.tz] : undefined;
  if (!offsets) throw new Error(`no UTC offsets known for zone ${p.tz}`);
  return offsets.map(off => {
    let h = p.hour - off;
    let dow = p.dow;
    if (h < 0) {
      h += 24;
      if (dow !== undefined) dow = (dow + 6) % 7;
    }
    return `${p.min} ${h} ${p.dom ?? '*'} ${p.mon ?? '*'} ${dow ?? '*'}`;
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
