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

/** Egypt's weekend day. Couriers work Saturdays, so Friday is the only skipped day. */
function isFriday(d: Date, timeZone: string): boolean {
  let name: string;
  try {
    name = new Intl.DateTimeFormat('en-US', { weekday: 'short', timeZone }).format(d);
  } catch {
    name = new Intl.DateTimeFormat('en-US', { weekday: 'short', timeZone: DEFAULT_TZ }).format(d);
  }
  return name === 'Fri';
}

/** Add `n` business days (Fridays never count, in `timeZone`), keeping the time of day. */
function addBusinessDays(from: Date, n: number, timeZone: string): Date {
  let t = from.getTime();
  for (let i = 0; i < n; i++) {
    t += DAY;
    while (isFriday(new Date(t), timeZone)) t += DAY;
  }
  return new Date(t);
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
