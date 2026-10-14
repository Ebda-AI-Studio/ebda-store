import { z } from 'zod';

/**
 * Store-wide delivery estimate (`Store.settings.deliveryDays`), in BUSINESS days.
 * The fallback for stores that price shipping per area (`ShippingAreaRate`, which
 * carries no day estimate) instead of per zone. Cleared with an explicit `null`
 * (the server's settings merge is shallow), so readers treat null like unset.
 */
export const DELIVERY_DAYS_MAX = 30;
export const deliveryDaysSchema = z
  .object({
    min: z.number().int().min(0).max(DELIVERY_DAYS_MAX),
    max: z.number().int().min(0).max(DELIVERY_DAYS_MAX),
  })
  .refine(d => d.min <= d.max, { message: 'min must be <= max', path: ['max'] });
export type DeliveryDays = z.infer<typeof deliveryDaysSchema>;

type Zone = {
  isActive: boolean;
  estimatedDaysMin: number | null;
  estimatedDaysMax: number | null;
  estimatedDays?: number | null;
};

const DAY = 86_400_000;
const DEFAULT_TZ = 'Africa/Cairo';
const FRIDAY = 5; // Date#getUTCDay

/** A usable IANA zone: a typo in store settings falls back to Cairo instead of throwing. */
function safeZone(timeZone: string): string {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return timeZone;
  } catch {
    return DEFAULT_TZ;
  }
}

function wallClock(instant: number, timeZone: string) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
  }).formatToParts(new Date(instant));
  const get = (type: string) => Number(parts.find(p => p.type === type)?.value);
  return {
    y: get('year'),
    mo: get('month'),
    d: get('day'),
    h: get('hour'),
    mi: get('minute'),
    s: get('second'),
  };
}

/** The instant whose wall clock in `timeZone` reads y-mo-d h:mi:s (DST-correct). */
function wallToInstant(
  w: { y: number; mo: number; d: number; h: number; mi: number; s: number },
  timeZone: string
): number {
  const asUtc = Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi, w.s);
  const offsetAt = (t: number) => {
    const c = wallClock(t, timeZone);
    return Date.UTC(c.y, c.mo - 1, c.d, c.h, c.mi, c.s) - Math.floor(t / 1000) * 1000;
  };
  const first = asUtc - offsetAt(asUtc);
  const second = asUtc - offsetAt(first);
  return second;
}

/**
 * Add `n` business days in the store timezone. Steps whole CALENDAR days (never 24h, which
 * drifts an hour across Egypt's DST switch), skips Fridays (Egypt's weekend; couriers work
 * Saturdays), and keeps the wall-clock time of day. Zero days from a Friday moves to Saturday.
 */
function addBusinessDays(from: Date, n: number, timeZone: string): Date {
  const tz = safeZone(timeZone);
  const w = wallClock(from.getTime(), tz);
  const ms = ((from.getTime() % 1000) + 1000) % 1000;
  // A UTC-noon Date stands for the calendar day; +24h on it is always the next calendar day.
  let cal = Date.UTC(w.y, w.mo - 1, w.d, 12);
  for (let i = 0; i < n; i++) {
    cal += DAY;
    while (new Date(cal).getUTCDay() === FRIDAY) cal += DAY;
  }
  if (new Date(cal).getUTCDay() === FRIDAY) cal += DAY;
  const c = new Date(cal);
  return new Date(
    wallToInstant(
      {
        y: c.getUTCFullYear(),
        mo: c.getUTCMonth() + 1,
        d: c.getUTCDate(),
        h: w.h,
        mi: w.mi,
        s: w.s,
      },
      tz
    ) + ms
  );
}

/**
 * "Delivers by" window for a product: fastest active zone that has numbers (min of the
 * mins, and that zone's max), else the store-wide `fallback`, plus the product's
 * made-to-order lead time. Everything is in business days (Fridays skipped, read in the
 * store timezone). Returns null when nothing has numbers, so the UI hides the chip
 * instead of printing "0 days" or "NaN".
 */
export function deliveryWindow(a: {
  now: Date;
  leadTimeDays: number | null;
  zones: Zone[];
  fallback?: { min: number; max: number } | null;
  /** IANA store timezone; defaults to Africa/Cairo. */
  timeZone?: string;
}): { from: Date; to: Date } | null {
  const ranges = a.zones
    .filter(z => z.isActive)
    .map(z => {
      const min = z.estimatedDaysMin ?? z.estimatedDays ?? null;
      const max = z.estimatedDaysMax ?? z.estimatedDays ?? min;
      return min == null || max == null ? null : { min, max: Math.max(min, max) };
    })
    .filter((r): r is { min: number; max: number } => r !== null)
    .sort((x, y) => x.min - y.min || x.max - y.max);

  let range = ranges[0] ?? null;
  if (!range && a.fallback && Number.isFinite(a.fallback.min) && Number.isFinite(a.fallback.max)) {
    range = { min: a.fallback.min, max: Math.max(a.fallback.min, a.fallback.max) };
  }
  if (!range) return null;

  const lead = Math.max(0, a.leadTimeDays ?? 0);
  const tz = a.timeZone || DEFAULT_TZ;
  return {
    from: addBusinessDays(a.now, range.min + lead, tz),
    to: addBusinessDays(a.now, range.max + lead, tz),
  };
}
