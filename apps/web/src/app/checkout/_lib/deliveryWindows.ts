/**
 * Pure, unit-tested helpers for the checkout delivery-window selector.
 *
 * Each window closes for ordering at its own merchant-configured "order-by"
 * time, falling back to the window's `start` time when unset — e.g.
 * ordering at 2pm disables a 1pm-5pm window with no order-by set, forcing
 * the customer to pick a later one. Once every configured window's
 * order-by time has passed for the day, the selector rolls over to
 * TOMORROW and every window reopens fresh (see `resolveDeliverySelection`).
 * No I/O, no Date.now() reads baked in: callers derive "now" separately
 * (see getNowMinutesInTimezone) and pass it in as minutes-since-midnight so
 * this stays trivially testable.
 */

export interface DeliveryWindowItem {
  id: string;
  label: string;
  labelAr: string;
  /** 24h "HH:mm", store-local time. */
  start: string;
  /** 24h "HH:mm", store-local time. */
  end: string;
  /**
   * Optional 24h "HH:mm", store-local time — the last moment a customer can
   * order for this window today. Falls back to `start` when unset/empty.
   */
  orderBy?: string;
}

export interface DeliveryWindowAvailability extends DeliveryWindowItem {
  available: boolean;
}

export type DeliveryDay = 'today' | 'tomorrow';

export interface DeliverySelection {
  day: DeliveryDay;
  windows: DeliveryWindowAvailability[];
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
 * Resolves a window's effective order-by cutoff, in minutes-since-midnight.
 * Uses `orderBy` when the merchant set one; falls back to `start` otherwise
 * (treating an empty string the same as unset, since a cleared <input
 * type="time"> yields '' rather than undefined).
 */
export function orderByMinutes(item: DeliveryWindowItem): number {
  return parseTimeToMinutes(item.orderBy || item.start);
}

/**
 * Computes TODAY's availability for every configured window against "now"
 * (minutes-since-midnight, store-local). available === nowMinutes is
 * strictly before the window's order-by cutoff (orderBy, or start when
 * orderBy is unset) — at/past that time, the window is closed for today.
 */
export function computeWindowAvailability(
  items: DeliveryWindowItem[],
  nowMinutes: number
): DeliveryWindowAvailability[] {
  return items.map(item => ({
    ...item,
    available: nowMinutes < orderByMinutes(item),
  }));
}

/**
 * Resolves which day's windows the customer should choose from. Stays on
 * TODAY — showing today's availability, closed windows disabled — while at
 * least one window's order-by time hasn't passed yet. Once every window is
 * past its order-by cutoff for today, rolls over to TOMORROW: a fresh day,
 * every window open again. A store with zero configured windows stays on
 * TODAY with an empty list rather than rolling over — there's nothing to
 * roll over to.
 */
export function resolveDeliverySelection(
  items: DeliveryWindowItem[],
  nowMinutes: number
): DeliverySelection {
  if (items.length === 0) {
    return { day: 'today', windows: [] };
  }
  const todayWindows = computeWindowAvailability(items, nowMinutes);
  if (todayWindows.some(w => w.available)) {
    return { day: 'today', windows: todayWindows };
  }
  return {
    day: 'tomorrow',
    windows: items.map(item => ({ ...item, available: true })),
  };
}

/**
 * Derives "now" as minutes-since-midnight in the given IANA timezone
 * (defaults handled by the caller — this repo's store default is
 * 'Asia/Kuwait'). Kept separate from the availability helpers so the pure
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
