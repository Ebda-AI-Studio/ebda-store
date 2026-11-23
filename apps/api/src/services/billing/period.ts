/** Pure date/price helpers for the subscription lifecycle (UTC, integer money). */

export type BillingInterval = 'monthly' | 'yearly';

export const FREE_PLAN_CODE = 'free';
export const COMPED_PLAN_CODE = 'comped';
/**
 * Admin-granted plans: never purchasable, never charged, always status `comped`.
 * `founding_free` stays defined but assigned to nobody (Ruling EBDA-FUNNEL-15).
 */
export const GRANTED_PLAN_CODES: readonly string[] = [COMPED_PLAN_CODE, 'founding_free'];
export const isGrantedPlan = (code: string): boolean => GRANTED_PLAN_CODES.includes(code);
/** Signup trial (locked pricing): 14 days on Growth whatever plan was chosen. */
export const TRIAL_DAYS = 14;
export const TRIAL_PLAN_CODE = 'growth';
/**
 * InstaPay (manual) subscriptions: days after the due date before an unpaid
 * store is suspended (Ruling EBDA-FUNNEL-11). A config constant by Ahmad's
 * decision; change it here, not per store.
 */
export const INSTAPAY_GRACE_DAYS = 3;
/** Reminder offsets in days before the due date (7, 3, 1 and the due day). */
export const REMINDER_OFFSETS = [7, 3, 1, 0] as const;
/** Dunning retry offsets in days after the missed period end: day 3, then day 7. */
export const DUNNING_RETRY_DAYS = [3, 7] as const;
/** Failed charges for one period before the store is downgraded (day 0 + 2 retries). */
export const MAX_DUNNING_ATTEMPTS = DUNNING_RETRY_DAYS.length + 1;

export function isInterval(v: unknown): v is BillingInterval {
  return v === 'monthly' || v === 'yearly';
}

/**
 * Add one billing interval in UTC, clamping the day to the target month. `anchorDay` (1-31) is the day of month the
 * subscription was STARTED on: the clamp is applied from it every cycle, so Jan 31 -> Feb 28 -> Mar 31 (not Mar 28 for
 * ever, M-125). Without an anchor the day of `from` is used (Jan 31 + 1 month = Feb 28/29).
 */
export function addIntervalAnchored(
  from: Date,
  interval: BillingInterval,
  anchorDay?: number | null
): Date {
  return addMonthsAnchored(from, interval === 'yearly' ? 12 : 1, anchorDay);
}

/** `addIntervalAnchored` for any whole number of months (same UTC day clamp). */
function addMonthsAnchored(from: Date, months: number, anchorDay?: number | null): Date {
  const y = from.getUTCFullYear();
  const m = from.getUTCMonth() + months;
  const lastDay = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  const wanted =
    typeof anchorDay === 'number' &&
    Number.isInteger(anchorDay) &&
    anchorDay >= 1 &&
    anchorDay <= 31
      ? anchorDay
      : from.getUTCDate();
  const d = new Date(from.getTime());
  d.setUTCDate(1);
  d.setUTCFullYear(y, m, Math.min(wanted, lastDay));
  return d;
}

/**
 * How many billing intervals the span [start, end) covers, rounded UP (min 1): the smallest k with
 * start + k intervals >= end, counted in calendar months from `start`'s own day (Jan 31 + 1 month = Feb 28/29,
 * +2 = Mar 31). A span of one month and one second is 2 intervals. Returns `max + 1` when the span is longer than
 * `max` intervals, so the caller can refuse it without looping unbounded.
 */
export function intervalsCovered(
  start: Date,
  end: Date,
  interval: BillingInterval,
  max = 120
): number {
  const step = interval === 'yearly' ? 12 : 1;
  const anchor = start.getUTCDate();
  let k = 1;
  while (addMonthsAnchored(start, k * step, anchor).getTime() < end.getTime()) {
    k += 1;
    if (k > max) return max + 1;
  }
  return k;
}

export function addInterval(from: Date, interval: BillingInterval): Date {
  return addIntervalAnchored(from, interval, undefined);
}

export function addDays(from: Date, days: number): Date {
  return new Date(from.getTime() + days * 86_400_000);
}

export function priceFor(
  plan: { priceMonthlyMinor: number | null; priceYearlyMinor: number | null },
  interval: BillingInterval
): number | null {
  return interval === 'yearly' ? plan.priceYearlyMinor : plan.priceMonthlyMinor;
}

/** Renewal idempotency key: attempt 0 is `sub:<id>:<periodEnd ISO>`, retries append `:retry<n>`. */
export function renewalKey(subId: string, periodEnd: Date, attempt: number): string {
  const base = `sub:${subId}:${periodEnd.toISOString()}`;
  return attempt === 0 ? base : `${base}:retry${attempt}`;
}

export function upgradeKey(subId: string, planCode: string, periodEnd: Date | null, n: number) {
  return `sub:${subId}:upgrade:${planCode}:${periodEnd ? periodEnd.toISOString() : 'none'}:${n}`;
}
