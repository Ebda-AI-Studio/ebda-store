/**
 * Bilingual VAT row copy for the checkout/cart order summary, shared by
 * every OrderSummary render path (the checkout page's own component + all 5
 * themed cart summaries) so the wording never drifts between them.
 *
 * Ruling M3-3 (docs/RULINGS.md): the checkout summary previously showed no
 * tax line at all, and its total excluded tax — a store with tax added on
 * top of prices showed the shopper a total lower than what they were
 * actually charged. `computeOrderTax` (from `@force/shared`) is now called
 * here with the SAME inputs order creation uses, so the amount this labels
 * always matches the charge.
 *
 * Exclusive tax (the default, `taxIncludedInPrice: false`) is a normal
 * summed row — "VAT (5%)" — and the caller's `total` must include it.
 * Tax already baked into the listed price renders as "Incl. VAT (5%)"
 * instead: informational only, and the caller's `total` must NOT add it
 * again.
 *
 * Returns `undefined` when there is nothing to show — no active tax rate,
 * tax disabled, or the discount already exceeds the subtotal — so a store
 * with tax off renders byte-identically to before this change.
 */
export function formatTaxRowLabel(
  tax: number,
  taxRatePercent: number,
  taxIncludedInPrice: boolean,
  isRtl: boolean,
  localize: (value: string | number) => string
): string | undefined {
  if (tax <= 0) return undefined;

  // Trim trailing zeros so a whole-number rate reads "5%", not "5.00%".
  const pct = localize(Number(taxRatePercent.toFixed(2)).toString());

  if (taxIncludedInPrice) {
    return isRtl ? `شامل ضريبة القيمة المضافة (${pct}%)` : `Incl. VAT (${pct}%)`;
  }
  return isRtl ? `ضريبة القيمة المضافة (${pct}%)` : `VAT (${pct}%)`;
}
