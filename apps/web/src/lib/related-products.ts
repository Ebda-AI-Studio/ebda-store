/**
 * Pure helpers for the product-detail "related products" strip.
 *
 * fetchProduct() was flagged at nesting depth 5, and the depth came entirely from
 * this feature: `if (categories?.length)` → `if (catId)` → `await` →
 * `if (relResponse.success)`. The two decisions inside that pyramid are pure, so
 * they live here where they can be asserted directly.
 */

interface CategoryLink {
  category?: { id?: string } | null;
}

/**
 * The category to draw related products from — the product's first.
 * Returns null when the product has no usable category, which is the signal to
 * skip the related fetch entirely rather than call the API with `undefined`.
 */
export function firstCategoryId(categories?: CategoryLink[] | null): string | null {
  const id = categories?.[0]?.category?.id;
  return id || null;
}

/**
 * Choose which products to show alongside the one being viewed.
 *
 * Excluding the current product matters: the API filters by category, so the
 * product you are looking at is almost always in its own related list, and
 * showing it there reads as a bug to the shopper.
 */
export function pickRelated<T extends { id: string }>(
  products: T[] | undefined | null,
  excludeId: string,
  limit = 3
): T[] {
  return (products ?? []).filter(p => p.id !== excludeId).slice(0, limit);
}
