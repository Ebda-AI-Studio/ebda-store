import { vatOnDiscounted } from './region';

/**
 * VAT on an order is levied AFTER discount (owner decision, #193 / ruling
 * M3-3 in docs/RULINGS.md): the taxable base is `subtotal − discount`, never
 * negative, where `discount` is the order's combined discount (winning
 * coupon-or-promotion plus loyalty).
 *
 * This is the ONE implementation of that formula, shared by the API (order
 * creation — the authoritative charge, `apps/api/src/lib/order-tax.ts`
 * re-exports it) and the storefront (checkout + cart summary display) so the
 * tax the customer is SHOWN can never drift from the tax they are CHARGED
 * (ruling M3-6, docs/RULINGS.md).
 *
 * `rate` is a fraction (5% → 0.05). A store with no active tax rate passes 0
 * and gets 0.
 *
 * `includedInPrice` (default `false`, exclusive — added on top, unchanged
 * behaviour) selects EXTRACTION instead of addition: when the store's listed
 * price already contains the tax, `base` IS the tax-inclusive amount, so the
 * tax portion is `base − base / (1 + rate)` (= `base × bps / (10000 + bps)`), and the caller must NOT add the
 * result to `base` again (both order creation and the storefront gate their
 * own `total` on this same flag — scoped-audit P1 follow-up, 2026-09-26).
 */
export function computeOrderTax(
  subtotal: number,
  discount: number,
  rate: number,
  includedInPrice = false
): number {
  // `rate` arrives as a fraction (0.14) from the resolver's percentage / 100.
  // Convert to whole basis points (1400) and do the arithmetic in integers:
  // `base * 0.14` in floating point can land on x.4999999 for a true half
  // piastre. Rounding rule (documented in region/index.ts): HALF UP to the
  // piastre — what FWB's `Math.round` already did.
  return vatOnDiscounted(subtotal, discount, Math.round(rate * 10_000), includedInPrice);
}
