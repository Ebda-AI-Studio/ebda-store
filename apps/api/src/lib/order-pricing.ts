/**
 * Shared glue between the price resolver and the paths that CREATE money rows (checkout, admin manual order, payment
 * links, WhatsApp bridge). docs/plans/2026-10-21-b2b-wholesale.md Task 3, Rulings B2B-5 / B2B-9.
 */
import type { Resolved } from '@ebda/shared';
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
export function priceSnapshot(r: Resolved): {
  listPrice: number;
  priceSource: Resolved['source'];
  priceTierMinQty: number | null;
} {
  return { listPrice: r.listMinor, priceSource: r.source, priceTierMinQty: r.tierMinQty };
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
