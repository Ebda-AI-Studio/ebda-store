/** Pure date/price helpers for the subscription lifecycle (UTC, integer money). */

export type BillingInterval = 'monthly' | 'yearly';

export const FREE_PLAN_CODE = 'free';
export const COMPED_PLAN_CODE = 'comped';
/** Admin-granted plans: never purchasable, never charged, always status `comped` (Amelia's founding deal). */
export const GRANTED_PLAN_CODES: readonly string[] = [COMPED_PLAN_CODE, 'founding_free'];
export const isGrantedPlan = (code: string): boolean => GRANTED_PLAN_CODES.includes(code);
/** Dunning retry offsets in days after the missed period end: day 3, then day 7. */
export const DUNNING_RETRY_DAYS = [3, 7] as const;
/** Failed charges for one period before the store is downgraded (day 0 + 2 retries). */
export const MAX_DUNNING_ATTEMPTS = DUNNING_RETRY_DAYS.length + 1;

export function isInterval(v: unknown): v is BillingInterval {
  return v === 'monthly' || v === 'yearly';
}

/** Add one billing interval in UTC, clamping the day (Jan 31 + 1 month = Feb 28/29). */
export function addInterval(from: Date, interval: BillingInterval): Date {
  const months = interval === 'yearly' ? 12 : 1;
  const y = from.getUTCFullYear();
  const m = from.getUTCMonth() + months;
  const lastDay = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  const d = new Date(from.getTime());
  d.setUTCDate(1);
  d.setUTCFullYear(y, m, Math.min(from.getUTCDate(), lastDay));
  return d;
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
