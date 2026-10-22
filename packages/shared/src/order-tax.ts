import { codFeeMinor, vatOnDiscounted } from './region';

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
  includedInPrice = false,
  /** Shipping + COD fee the seller charges (ruling MONEYB-2): in the VAT base. */
  chargesMinor = 0
): number {
  // `rate` arrives as a fraction (0.14) from the resolver's percentage / 100.
  // Convert to whole basis points (1400) and do the arithmetic in integers:
  // `base * 0.14` in floating point can land on x.4999999 for a true half
  // piastre. Rounding rule (documented in region/index.ts): HALF UP to the
  // piastre — what Ebda Store's `Math.round` already did.
  return vatOnDiscounted(
    subtotal,
    discount,
    Math.round(rate * 10_000),
    includedInPrice,
    chargesMinor
  );
}

/**
 * Every money figure of one order, in the ONE order the shopper, the merchant
 * and the tax invoice read them (ruling MONEYB-2):
 *
 *   subtotal → discounts → shipping → COD fee → taxable amount → VAT → total
 *
 * The VAT base is the value of the whole supply the seller bills: goods after
 * the discounts shown on the invoice, plus the shipping it charges and the COD
 * fee (VAT Law 67/2016 Art. 10; Exec. Regs Art. 11 item 1). Shared by cart,
 * checkout, order creation (storefront, admin, agent), the invoice, the
 * confirmation email and every order summary, so the numbers cannot drift.
 *
 * `ratePercent` is a percentage (14 = 14%). Under `includedInPrice` every
 * amount (goods, shipping, COD fee) is gross and the VAT is extracted, not added.
 */
export interface OrderAmountsInput {
  subtotal: number;
  discount: number;
  shipping: number;
  codFee?: number;
  ratePercent: number;
  includedInPrice?: boolean;
}

export interface OrderAmounts {
  /** Net value VAT is charged on (excl. VAT). */
  taxableAmount: number;
  tax: number;
  total: number;
}

export function computeOrderAmounts(i: OrderAmountsInput): OrderAmounts {
  const goods = Math.max(0, i.subtotal - i.discount);
  const charges = Math.max(0, i.shipping) + Math.max(0, i.codFee ?? 0);
  const included = !!i.includedInPrice;
  const tax = computeOrderTax(i.subtotal, i.discount, i.ratePercent / 100, included, charges);
  const gross = goods + charges;
  return {
    taxableAmount: included ? Math.max(0, gross - tax) : gross,
    tax,
    total: included ? gross : gross + tax,
  };
}

/** The COD settings a storefront needs to quote the fee BEFORE the order is placed. */
export interface CodFeeConfig {
  /** Fixed part, piastres. */
  fixedFee?: number;
  /** Percentage part in basis points (200 = 2%). */
  percentBps?: number;
}

/**
 * The cash-on-delivery fee for an order (ruling MONEYB-3): fixed part plus the
 * percentage of the value the courier collects for the goods and delivery —
 * `max(0, subtotal − discount) + shipping` — before VAT and before the fee
 * itself (no fee-on-fee, no fee-on-VAT). Quoted at checkout and frozen on the
 * order at creation by the same function.
 */
export function codFeeForOrder(
  amounts: { subtotal: number; discount: number; shipping: number },
  cfg: CodFeeConfig | null | undefined
): number {
  if (!cfg) return 0;
  const base = Math.max(0, amounts.subtotal - amounts.discount) + Math.max(0, amounts.shipping);
  const percentBps = Number.isFinite(cfg.percentBps) ? Number(cfg.percentBps) : 0;
  return codFeeMinor(base, {
    fixedMinor: Math.max(0, Math.round(Number(cfg.fixedFee) || 0)),
    percentBps: Math.max(0, Math.round(percentBps)),
  });
}
