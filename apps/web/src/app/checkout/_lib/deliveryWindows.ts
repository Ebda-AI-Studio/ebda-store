/**
 * Pure, unit-tested helpers for the checkout delivery-window selector.
 *
 * A window is DISABLED once the current store-local time reaches (or
 * passes) its start time — e.g. ordering at 2pm disables a 1pm-5pm window,
 * forcing the customer to pick a later one. No I/O, no Date.now() reads
 * baked in: callers derive "now" separately (see getNowMinutesInTimezone)
 * and pass it in as minutes-since-midnight so this stays trivially testable.
 */

export interface DeliveryWindowItem {
  id: string;
  label: string;
  labelAr: string;
  /** 24h "HH:mm", store-local time. */
  start: string;
  /** 24h "HH:mm", store-local time. */
  end: string;
}

export interface DeliveryWindowAvailability extends DeliveryWindowItem {
  available: boolean;
}

/**
 * Parses a "HH:mm" 24h string into minutes-since-midnight. Malformed input
 * falls back to 0 (midnight) rather than throwing — a merchant typo should
 * never crash checkout; worst case that window reads as "always past".
 */
export function parseTimeToMinutes(time: string): number {
  const match = /^(\d{1,2}):(\d{2})$/.exec((time ?? '').trim());
  if (!match) return 0;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return 0;
  return hours * 60 + minutes;
}

/**
 * Computes availability for every configured window against "now"
 * (minutes-since-midnight, store-local). available === nowMinutes is
 * strictly before the window's start — at/past start, the window is
 * disabled per the platform's delivery-window rule.
 */
export function computeWindowAvailability(
  items: DeliveryWindowItem[],
  nowMinutes: number
): DeliveryWindowAvailability[] {
  return items.map(item => ({
    ...item,
    available: nowMinutes < parseTimeToMinutes(item.start),
  }));
}

/**
 * Derives "now" as minutes-since-midnight in the given IANA timezone
 * (defaults handled by the caller — this repo's store default is
 * 'Asia/Kuwait'). Kept separate from computeWindowAvailability so the pure
 * logic never depends on Date.now() / Intl directly and stays deterministic
 * under test.
 */
export function getNowMinutesInTimezone(timezone: string, now: Date = new Date()): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(now);
  const hour = Number(parts.find(p => p.type === 'hour')?.value ?? '0');
  const minute = Number(parts.find(p => p.type === 'minute')?.value ?? '0');
  // Some environments render midnight as "24" under hour12:false — normalize.
  return (hour % 24) * 60 + minute;
}
