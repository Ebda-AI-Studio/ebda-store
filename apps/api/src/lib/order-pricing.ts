/**
 * Shared glue between the price resolver and the paths that CREATE money rows (checkout, admin manual order, payment
 * links, WhatsApp bridge). docs/plans/done/2026-10-21-b2b-wholesale.md Task 3, Rulings B2B-5 / B2B-9.
 */
import type { Resolved, TierLadderSnapshot } from '@ebda/shared';
import { AppError } from '../middleware/error-handler';

export interface MoqLine {
  productId: string;
  name: string;
  nameAr?: string | null;
  /** Total quantity of the product across the order (MOQ is judged on the product total). */
  current: number;
  resolved: Resolved;
}

/**
 * Review Focus 7: below MOQ the cart may be built up, but an ORDER may not be created. Throws 422 `BELOW_MOQ` listing ALL
 * offending products (deduplicated), not just the first, so the cart can mark every one at once.
 */
export function assertMoqSatisfied(lines: readonly MoqLine[]): void {
  const offending = new Map<
    string,
    { productId: string; name: string; nameAr: string | null; required: number; current: number }
  >();
  for (const l of lines) {
    if (l.resolved.belowMoq && l.resolved.moqRequired !== null && !offending.has(l.productId)) {
      offending.set(l.productId, {
        productId: l.productId,
        name: l.name,
        nameAr: l.nameAr ?? null,
        required: l.resolved.moqRequired,
        current: l.current,
      });
    }
  }
  if (offending.size === 0) return;
  const lines2 = [...offending.values()];
  throw new AppError(
    422,
    'BELOW_MOQ',
    `Minimum order quantity not met: ${lines2.map(o => `${o.name} (min ${o.required})`).join(', ')}`,
    { lines: lines2 }
  );
}

/** The persisted price provenance for one order line (Ruling B2B-3b/5): invoices, returns and analytics read these, never re-resolve. */
/**
 * The label printed under an order line that was NOT sold at the plain retail price (invoice, credit note), from the
 * snapshot persisted on the line - never re-resolved. A price from the buyer's wholesale GROUP (group tier or group
 * percent) reads "Wholesale price"; a PUBLIC quantity break, which any shopper can reach, reads "Quantity price" (final
 * review minor 4: it used to say "Wholesale price" on a retail shopper's invoice). A break carries its threshold. Latin
 * digits in both languages (NUMERALS-1). null for a retail line and for a line sold before the snapshot existed, so an old
 * invoice renders exactly as it always did.
 */
export function priceLineLabel(
  i: {
    priceSource?: string | null;
    priceTierMinQty?: number | null;
    priceGroupApplied?: boolean | null;
  },
  lang: 'en' | 'ar'
): string | null {
  if (i.priceSource === 'group') return lang === 'ar' ? 'سعر الجملة' : 'Wholesale price';
  if (i.priceSource !== 'tier') return null;
  const wholesale = i.priceGroupApplied === true;
  const name =
    lang === 'ar'
      ? wholesale
        ? 'سعر الجملة'
        : 'سعر الكمية'
      : wholesale
        ? 'Wholesale price'
        : 'Quantity price';
  if (i.priceTierMinQty == null) return name;
  return lang === 'ar'
    ? `${name}، ${i.priceTierMinQty}+ وحدة`
    : `${name}, ${i.priceTierMinQty}+ units`;
}

/** The retail list price to strike through beside the charged unit price: only when the line was sold below it. */
export function struckListPrice(i: {
  priceSource?: string | null;
  listPrice?: number | null;
  price: number;
}): number | null {
  return i.priceSource && i.priceSource !== 'base' && i.listPrice != null && i.listPrice > i.price
    ? i.listPrice
    : null;
}

export function priceSnapshot(r: Resolved): {
  listPrice: number;
  priceSource: Resolved['source'];
  priceTierMinQty: number | null;
  /** The price came from the buyer's group (labels + analytics, final review minor 4). */
  priceGroupApplied: boolean;
  /**
   * The buyer's entitlement at sale time (Task 8b, Rulings B2B-17 / B2B-18): the price breaks on offer with their scope and
   * audience, plus the group-percent price. Read only by a later partial return. undefined when there were no breaks, so the
   * column stays NULL for plain lines (a line with no break can never be repriced).
   */
  tierLadder: TierLadderSnapshot | undefined;
} {
  return {
    listPrice: r.listMinor,
    priceSource: r.source,
    priceTierMinQty: r.tierMinQty,
    priceGroupApplied: r.groupApplied,
    tierLadder:
      r.ladder.length > 0
        ? { rungs: r.ladder.map(x => ({ ...x })), groupPercentMinor: r.groupPercentMinor }
        : undefined,
  };
}

/**
 * Lines priced by a tier or a group price are excluded from every coupon / promotion basis (Ruling B2B-5): wholesale margin is
 * thin and stacking a coupon on a tier price can go below cost. Base-priced lines (including a tier that gave no discount)
 * stay eligible.
 */
export function eligibleForCoupon(r: Resolved): boolean {
  return r.source === 'base';
}

/**
 * The goods value loyalty points may be redeemed against (Ruling B2B-M3): the order subtotal minus the lines priced by a tier
 * or a group price (the same exclusion as coupons, B2B-5) minus the primary (coupon / promotion) discount, floored at 0.
 */
export function loyaltyRedeemableSubtotal(i: {
  subtotal: number;
  nonBaseSubtotal: number;
  primaryDiscount: number;
}): number {
  return Math.max(0, i.subtotal - i.nonBaseSubtotal - i.primaryDiscount);
}
