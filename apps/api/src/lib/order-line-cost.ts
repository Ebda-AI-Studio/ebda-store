/**
 * The unit cost (piastres) an order line snapshots at sale time.
 *
 * A variant line takes the VARIANT's cost and falls back to the parent
 * product's; a variant-less line takes the product's. `null` means "no cost
 * known" — never 0, which would read as a free item and report the whole
 * price as profit. This is the same `variant.costPrice ?? product.costPrice`
 * rule `accounting/account.service.ts` uses to value inventory.
 *
 * The product must carry the line's variant in `variants` (select only the
 * cart's variant ids); a variant that is not there falls back to the parent.
 */
export function lineUnitCost(
  product:
    | {
        costPrice: number | null;
        variants?: Array<{ id: string; costPrice: number | null }>;
      }
    | null
    | undefined,
  variantId?: string | null
): number | null {
  if (!product) return null;
  if (variantId) {
    const variant = product.variants?.find(v => v.id === variantId);
    if (variant && variant.costPrice != null) return variant.costPrice;
  }
  return product.costPrice ?? null;
}
