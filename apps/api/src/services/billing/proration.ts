/**
 * THE single place a mid-period plan change is priced (Ruling G35-PRORATE-1).
 *
 *  - UPGRADE (the new plan costs more for the same interval) takes effect at once and charges the prorated
 *    difference: (new total - old total) x remaining days / period days, VAT included, rounded UP to the piastre.
 *    The paid period keeps its start and end; only the plan changes.
 *  - DOWNGRADE takes effect at the end of the paid period: nothing is charged, nothing is refunded or credited.
 *
 * "Total" is what a card is charged for the plan today (`subscriptionChargeAmount`, Ebda VAT applied), so a VAT
 * setting change is priced the same way as every other charge. Days are whole UTC days: a started day counts as a
 * remaining day (rounding in Ebda's favour, like the amount). Remaining days never exceed the period's days (a free
 * month carried onto the period end makes the period longer, it never makes the difference larger than one full
 * difference). Pure: every caller (card change-plan, the quote endpoint, the assistant card, the InstaPay amount, the
 * manual-payment check) reads this one function, so changing the rule is one PR.
 */
import {
  subscriptionChargeAmount,
  vatOfPaidAmount,
  type ChargeAmount,
  type PlatformVat,
} from './charge-amount';
import type { BillingInterval } from './period';

const DAY_MS = 86_400_000;

type PlanChangeKind = 'upgrade' | 'downgrade' | 'same';

export interface PlanChangeQuote {
  kind: PlanChangeKind;
  /** Whole days left in the paid period (a started day counts), 0..periodDays. */
  remainingDays: number;
  periodDays: number;
  /** Full-period totals (VAT included) of the two plans, for the "from / to" rows. */
  currentTotalMinor: number;
  newTotalMinor: number;
  /** What is charged now: the prorated difference (upgrade), else zero. VAT carved out of the total. */
  charge: ChargeAmount;
  /** When the new plan takes effect: now for an upgrade, the period end for a downgrade. */
  effectiveAt: Date;
  /** The paid period after the change (unchanged by an upgrade). */
  periodEnd: Date;
}

/**
 * The start of the paid period that ends at `periodEnd`, for a row with no start recorded: one interval back, the day
 * clamped to the target month (Mar 31 -> Feb 28/29), the inverse of `addIntervalAnchored`.
 */
export function periodStartFor(periodEnd: Date, interval: BillingInterval): Date {
  const months = interval === 'yearly' ? 12 : 1;
  const y = periodEnd.getUTCFullYear();
  const m = periodEnd.getUTCMonth() - months;
  const lastDay = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  const d = new Date(periodEnd.getTime());
  d.setUTCDate(1);
  d.setUTCFullYear(y, m, Math.min(periodEnd.getUTCDate(), lastDay));
  return d;
}

/** Whole days between two instants, a started day counting as one (never negative). */
// pq-allow(unused-export): test seam, imported by tests/unit/billing-proration.test.ts
export function wholeDaysCeil(from: Date, to: Date): number {
  const ms = to.getTime() - from.getTime();
  return ms <= 0 ? 0 : Math.ceil(ms / DAY_MS);
}

/**
 * Price a plan change inside the current paid period. `currentPriceMinor` / `newPriceMinor` are the catalogue prices
 * for the SAME interval (the subscription's). `vat` is required on purpose (see `subscriptionChargeAmount`).
 */
export function quotePlanChange(args: {
  currentPriceMinor: number;
  newPriceMinor: number;
  periodStart: Date;
  periodEnd: Date;
  now: Date;
  vat: PlatformVat;
  /**
   * What was actually PAID for the current period (VAT included), when known. The credit for the current plan is
   * min(catalogue total, paid): a promo or an older price never credits more than the merchant paid (money review C3).
   */
  paidTotalMinor?: number | null;
}): PlanChangeQuote {
  const { currentPriceMinor, newPriceMinor, periodStart, periodEnd, now, vat } = args;
  const catalogueCurrentTotal = subscriptionChargeAmount(currentPriceMinor, vat).totalMinor;
  const currentTotalMinor =
    args.paidTotalMinor !== undefined && args.paidTotalMinor !== null
      ? Math.max(0, Math.min(catalogueCurrentTotal, args.paidTotalMinor))
      : catalogueCurrentTotal;
  const newTotalMinor = subscriptionChargeAmount(newPriceMinor, vat).totalMinor;
  const periodDays = Math.max(
    1,
    Math.round((periodEnd.getTime() - periodStart.getTime()) / DAY_MS)
  );
  const remainingDays = Math.min(periodDays, wholeDaysCeil(now, periodEnd));
  const nothing = vatOfPaidAmount(0, vat);
  if (newPriceMinor === currentPriceMinor) {
    return {
      kind: 'same',
      remainingDays,
      periodDays,
      currentTotalMinor,
      newTotalMinor,
      charge: nothing,
      effectiveAt: now,
      periodEnd,
    };
  }
  if (newPriceMinor < currentPriceMinor) {
    return {
      kind: 'downgrade',
      remainingDays,
      periodDays,
      currentTotalMinor,
      newTotalMinor,
      charge: nothing,
      effectiveAt: periodEnd > now ? periodEnd : now,
      periodEnd,
    };
  }
  const diff = newTotalMinor - currentTotalMinor;
  // integer ceil(diff * remaining / period): diff < 1e9 piastres and days <= 366, so the product is an exact integer.
  const totalMinor = Math.ceil((diff * remainingDays) / periodDays);
  return {
    kind: 'upgrade',
    remainingDays,
    periodDays,
    currentTotalMinor,
    newTotalMinor,
    charge: vatOfPaidAmount(totalMinor, vat),
    effectiveAt: now,
    periodEnd,
  };
}
