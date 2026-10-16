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

/**
 * Per-store courier calendar (`Store.settings.deliveryOffDays`): weekdays with NO delivery, as
 * `Date#getUTCDay` numbers (0=Sun ... 6=Sat). Unset/null = Friday only (Egypt's weekend, the
 * behaviour before this setting existed); `[]` = delivers every day. Unique ints 0-6 and at
 * least one working day (max 6 entries). Cleared with an explicit `null` (shallow settings merge).
 */
export const DEFAULT_DELIVERY_OFF_DAYS: readonly number[] = [5];
export const deliveryOffDaysSchema = z
  .array(z.number().int().min(0).max(6))
  .max(6, { message: 'at least one delivery day is required' })
  .refine(d => new Set(d).size === d.length, { message: 'days must be unique' });
export type DeliveryOffDays = z.infer<typeof deliveryOffDaysSchema>;

type Zone = {
  isActive: boolean;
  estimatedDaysMin: number | null;
  estimatedDaysMax: number | null;
  estimatedDays?: number | null;
};

const DAY = 86_400_000;
const DEFAULT_TZ = 'Africa/Cairo';

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
 * drifts an hour across Egypt's DST switch), skips the store's off days (default Friday,
 * Egypt's weekend; couriers work Saturdays), and keeps the wall-clock time of day. Zero days
 * from an off day moves to the next working day.
 */
function addBusinessDays(from: Date, n: number, timeZone: string, off: ReadonlySet<number>): Date {
  const tz = safeZone(timeZone);
  const w = wallClock(from.getTime(), tz);
  const ms = ((from.getTime() % 1000) + 1000) % 1000;
  // A UTC-noon Date stands for the calendar day; +24h on it is always the next calendar day.
  let cal = Date.UTC(w.y, w.mo - 1, w.d, 12);
  for (let i = 0; i < n; i++) {
    cal += DAY;
    while (off.has(new Date(cal).getUTCDay())) cal += DAY;
  }
  while (off.has(new Date(cal).getUTCDay())) cal += DAY;
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
 * made-to-order lead time. Everything is in business days (the store's off days skipped, Friday
 * by default; read in the store timezone). Returns null when nothing has numbers, so the UI hides the chip
 * instead of printing "0 days" or "NaN".
 */
export function deliveryWindow(a: {
  now: Date;
  leadTimeDays: number | null;
  zones: Zone[];
  fallback?: { min: number; max: number } | null;
  /** IANA store timezone; defaults to Africa/Cairo. */
  timeZone?: string;
  /**
   * Weekdays with no delivery (`getUTCDay` numbers). null/undefined/invalid = Friday only;
   * applies to zone estimates and the fallback alike (it is the store's courier calendar).
   */
  offDays?: number[] | null;
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
  const parsedOff = deliveryOffDaysSchema.safeParse(a.offDays);
  const off = new Set<number>(parsedOff.success ? parsedOff.data : DEFAULT_DELIVERY_OFF_DAYS);
  return {
    from: addBusinessDays(a.now, range.min + lead, tz, off),
    to: addBusinessDays(a.now, range.max + lead, tz, off),
  };
}

/** The parts of an order's shipping address a zone can name. */
export interface DeliveryAddressLike {
  area?: string | null;
  areaAr?: string | null;
  governorate?: string | null;
  governorateAr?: string | null;
  city?: string | null;
}

/**
 * Fold a place name for an exact comparison: case, surrounding and repeated
 * spacing, Arabic diacritics/tatweel and the common Arabic letter variants
 * (أ/إ/آ → ا, ى → ي, ة → ه). Nothing is dropped beyond that, so two folded names
 * are equal only when they name the same place the same way.
 */
export function foldPlaceName(v: string | null | undefined): string {
  return (v ?? '')
    .toLowerCase()
    .replace(/[\u064B-\u065F\u0670\u0640]/g, '')
    .replace(/[أإآٱ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه')
    .trim()
    .replace(/\s+/g, ' ');
}

/**
 * The shipping zone an ORDER ships to (receipt / order pages AND the checkout's
 * legacy zone fee, `resolveShippingFee`): the first zone whose area names
 * include the address's area (en or ar), else its city, else its governorate.
 * Names match WHOLE after `foldPlaceName`, never as a substring: "Victoria"
 * contains "Tor" and "New Cairo" contains "Cairo", and a substring hit charged
 * and promised another zone's fee and window (B0-46 T15 carry 5).
 * null when no zone names the address. Never "the fastest zone": a dated
 * promise on a known address must be that address's window (W1c review I4).
 */
export function zoneForAddress<
  Z extends { areas?: readonly string[] | null; areasAr?: readonly string[] | null },
>(address: DeliveryAddressLike | null | undefined, zones: readonly Z[]): Z | null {
  if (!address) return null;
  const names = (z: Z) =>
    [...(z.areas ?? []), ...(z.areasAr ?? [])].map(foldPlaceName).filter(Boolean);
  const tries = [
    address.area,
    address.areaAr,
    address.city,
    address.governorate,
    address.governorateAr,
  ].map(foldPlaceName);
  for (const value of tries) {
    if (!value) continue;
    const hit = zones.find(z => names(z).includes(value));
    if (hit) return hit;
  }
  return null;
}
