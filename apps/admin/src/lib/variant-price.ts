import { minorToDecimalString, roundToMinor } from '@ebda/shared';
/**
 * `ProductVariant.price` is `Int?` — an OVERRIDE, where null means "sell at the
 * product's price". The variants endpoint returns the raw row, so admin code
 * that reads it as a plain number prices an inheriting variant at 0 (#1919).
 * Every storefront/API consumer applies `variant.price ?? product.price`; these
 * helpers are the admin's copy of that rule.
 */

/** The price a variant actually sells at, in piastres. */
export function effectiveVariantPrice(variantPrice: number | null, productPrice: number): number {
  return variantPrice ?? productPrice;
}

/** An override price for an editable EGP field: empty when the variant inherits. */
export function variantPriceToField(piastres: number | null): string {
  return piastres === null ? '' : minorToDecimalString(piastres);
}

/**
 * A EGP field back to an override price. Empty keeps inheriting (null) — it
 * must never become 0, which would pin the variant to a zero price.
 */
export function variantFieldToPrice(field: string): number | null {
  if (field.trim() === '') return null;
  const n = parseFloat(field);
  if (isNaN(n) || n < 0) return 0;
  return roundToMinor(n);
}
