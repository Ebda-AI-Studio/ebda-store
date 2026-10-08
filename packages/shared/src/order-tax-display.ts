/**
 * How a PLACED order's `tax` renders on a post-purchase summary (issue 2210).
 *
 * `Order.taxIncludedInPrice` (frozen at sale time — Ruling M3-8) says whether
 * `tax` is already inside `subtotal`/`total`. Exclusive tax (the default) is a
 * normal summed row between the discounts and the total. Inclusive tax must
 * NOT be a summed row — Subtotal + Tax + Shipping would then exceed the printed
 * Total by exactly `tax` — so it renders as an informational caption after the
 * Total instead, the same treatment the checkout summary settled on
 * (apps/web/src/lib/tax-display.ts, Ruling M3-7).
 *
 * Display only: this never changes an amount, only where the one `tax` value
 * is printed. Every post-purchase surface (storefront order detail, admin and
 * orders-PWA SummaryCards, the invoice) takes the placement from here so they
 * cannot disagree about the same order.
 */
export interface OrderTaxPlacement {
  /** Amount to print as a summed row before Total, or null for no row. */
  taxRow: number | null;
  /** Amount to print as an "incl. VAT" caption after Total, or null. */
  includedTaxCaption: number | null;
}

export function orderTaxPlacement(order: {
  tax: number;
  taxIncludedInPrice?: boolean | null;
}): OrderTaxPlacement {
  if (order.taxIncludedInPrice) {
    return { taxRow: null, includedTaxCaption: order.tax > 0 ? order.tax : null };
  }
  return { taxRow: order.tax, includedTaxCaption: null };
}

/**
 * Whether a PLACED order's documents are a TAX invoice (ruling TAX-2): only
 * when the order froze a seller tax registration number at sale time, which
 * happens only when VAT was collected under a VERIFIED tax profile. `null` =
 * an ordinary invoice: no "tax invoice" heading, no TRN, no rate label.
 *
 * `taxableAmount` is the VAT base (after discount, before VAT) the order froze
 * at creation: goods after discount + shipping + COD fee (ruling MONEYB-2).
 */
export interface TaxInvoiceInfo {
  sellerTaxRegistrationNumber: string;
  sellerTaxLegalName: string | null;
  /** e.g. 14 for 14%; null when the order did not record a rate. */
  ratePercent: number | null;
  taxableAmount: number;
  vatAmount: number;
}

export function taxInvoiceInfo(order: {
  sellerTaxRegistrationNumber?: string | null;
  sellerTaxLegalName?: string | null;
  taxRateBps?: number | null;
  subtotal: number;
  discount?: number | null;
  tax: number;
  taxIncludedInPrice?: boolean | null;
  /** Frozen VAT base (ruling MONEYB-2); NULL on orders placed before it existed. */
  taxableAmount?: number | null;
}): TaxInvoiceInfo | null {
  if (!order.sellerTaxRegistrationNumber) return null;
  // Orders since MONEYB-2 froze their own base (goods after discount + shipping
  // + COD fee). Older orders were taxed on goods only — rebuild that base.
  const legacyBase = Math.max(0, order.subtotal - (order.discount ?? 0));
  const legacyTaxable = order.taxIncludedInPrice ? Math.max(0, legacyBase - order.tax) : legacyBase;
  return {
    sellerTaxRegistrationNumber: order.sellerTaxRegistrationNumber,
    sellerTaxLegalName: order.sellerTaxLegalName ?? null,
    ratePercent: order.taxRateBps == null ? null : order.taxRateBps / 100,
    taxableAmount: order.taxableAmount ?? legacyTaxable,
    vatAmount: order.tax,
  };
}
