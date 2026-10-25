/**
 * The next time a cron expression fires after an instant, for DO alarms (G5). The same grammar and
 * the same DST rule as the Cron Triggers in schedule.ts: a zoned expression (`TZ=Africa/Cairo 0 1 * * *`)
 * is expanded to its winter and summer UTC candidates and each candidate is kept only if the zone's
 * real local time matches, so a clock change moves the alarm with the wall clock, never by an hour.
 */
import { matchesLocal, parseCron, utcCronsFor } from './cron-expr';

const DAY_MS = 86_400_000;

// A field (star, n, a,b, a-b, star-slash-n, a-b/n) -> the matching values in [lo, hi].
function expand(field: string, lo: number, hi: number): number[] | undefined {
  if (field === '*') return undefined; // unrestricted
  const out = new Set<number>();
  for (const part of field.split(',')) {
    const m = /^(?:(\*)|(\d+)(?:-(\d+))?)(?:\/(\d+))?$/.exec(part);
    if (!m) throw new Error(`unsupported cron field "${field}"`);
    const step = m[4] ? Number(m[4]) : 1;
    const from = m[1] ? lo : Number(m[2]);
    const to = m[1] ? hi : m[3] ? Number(m[3]) : m[4] ? hi : from;
    for (let v = from; v <= to; v += step) out.add(v);
  }
  return [...out].sort((x, y) => x - y);
}

/** Candidate UTC instants of one 5-field UTC cron after `after`, within `days` days. */
function utcCandidates(utcExpr: string, after: number, days: number): number[] {
  const [minF, hourF, domF, monF, dowF] = utcExpr.trim().split(/\s+/);
  const mins = expand(minF, 0, 59) ?? Array.from({ length: 60 }, (_, i) => i);
  const hours = expand(hourF, 0, 23) ?? Array.from({ length: 24 }, (_, i) => i);
  const dom = expand(domF, 1, 31);
  const mon = expand(monF, 1, 12);
  const dow = expand(dowF, 0, 6);
  const out: number[] = [];
  const day0 = Math.floor(after / DAY_MS) * DAY_MS;
  for (let d = 0; d <= days; d++) {
    const dayStart = new Date(day0 + d * DAY_MS);
    if (dom && !dom.includes(dayStart.getUTCDate())) continue;
    if (mon && !mon.includes(dayStart.getUTCMonth() + 1)) continue;
    if (dow && !dow.includes(dayStart.getUTCDay())) continue;
    for (const h of hours)
      for (const m of mins) {
        const t = dayStart.getTime() + h * 3_600_000 + m * 60_000;
        if (t > after) out.push(t);
      }
  }
  return out;
}

/** Epoch ms of the next fire strictly after `after`; searches `horizonDays` ahead (yearly crons need > 366). */
export function nextRunAfter(expr: string, after: number, horizonDays = 400): number {
  if (/^\s*TZ=/.test(expr)) parseCron(expr); // validates the zoned grammar
  const hits = utcCronsFor(expr)
    .flatMap(u => utcCandidates(u, after, horizonDays))
    .filter(t => matchesLocal(expr, new Date(t)))
    .sort((a, b) => a - b);
  if (hits.length === 0) throw new Error(`cron never fires within ${horizonDays} days: ${expr}`);
  return hits[0];
}
