/**
 * Is this product sold as one of its variants? — the admin pickers' ONE rule
 * (W1a re-review minor 4). The API's VARIANT_REQUIRED gates (manual order,
 * payment link, purchase order) key on the variant ROWS; the admin product list
 * ships that count as `variantCount`. The `hasVariants` column is only the
 * fallback for a payload without it: if the column drifted from the rows, a
 * picker keyed on it hid the size select and the API then refused the request.
 */
export function isVariantProduct(
  p:
    | {
        variantCount?: number | null;
        hasVariants?: boolean | null;
      }
    | null
    | undefined
): boolean {
  if (!p) return false;
  return typeof p.variantCount === 'number' ? p.variantCount > 0 : p.hasVariants === true;
}
