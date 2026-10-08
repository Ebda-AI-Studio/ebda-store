/**
 * Pickup dates and windows are what the merchant picked on the Africa/Cairo wall clock
 * (PROVIDERS-18). Egypt observes daylight saving (UTC+2 / UTC+3), so a fixed offset would be
 * an hour wrong for half the year: the offset is read from the IANA zone for that instant.
 */
export const PICKUP_TIME_ZONE = 'Africa/Cairo';

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

export const isPickupDate = (v: string): boolean => {
  const m = DATE_RE.exec(v);
  if (!m) return false;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3];
};
export const isPickupTime = (v: string): boolean => TIME_RE.test(v);

/** Offset of `zone` from UTC at `instant`, in minutes (Cairo: +120 or +180). */
function offsetMinutes(instant: Date, zone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(instant);
  const get = (t: string) => Number(parts.find(p => p.type === t)?.value);
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'));
  return Math.round((asUtc - instant.getTime()) / 60_000);
}

/** The UTC instant of `date` `time` on the Cairo wall clock. */
export function cairoWallClock(date: string, time: string): Date {
  const d = DATE_RE.exec(date);
  const t = TIME_RE.exec(time);
  if (!d || !t) throw new RangeError(`not a pickup date/time: ${date} ${time}`);
  const naive = Date.UTC(+d[1], +d[2] - 1, +d[3], +t[1], +t[2]);
  let guess = naive - offsetMinutes(new Date(naive), PICKUP_TIME_ZONE) * 60_000;
  // A second pass settles the instants next to a DST switch.
  guess = naive - offsetMinutes(new Date(guess), PICKUP_TIME_ZONE) * 60_000;
  return new Date(guess);
}

/** Today's date on the Cairo wall clock (YYYY-MM-DD). */
export function cairoToday(now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: PICKUP_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}
