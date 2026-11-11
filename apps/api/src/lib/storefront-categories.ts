/**
 * Shoppers never see an empty category (QA-B2: the empty default «المنتجات / Products» was linked from the
 * storefront nav, home and /categories, and its page said "no products"). Every shopper-facing category list
 * (`/public/categories` -> nav, home, /categories, sitemap, llms.txt; the filter options; search suggestions)
 * goes through this one rule, so a new surface cannot forget it.
 *
 * Keep a category when it holds at least one product a shopper can see, or when it is the ancestor of one that
 * does (hiding the parent would orphan its children in a tree). The merchant admin list is NOT filtered.
 */
export function visibleToShoppers<T extends { id: string; parentId?: string | null }>(
  categories: readonly T[],
  productCountOf: (category: T) => number
): T[] {
  const byId = new Map(categories.map(c => [c.id, c]));
  const keep = new Set<string>();
  for (const c of categories) {
    if (productCountOf(c) <= 0) continue;
    // Walk up the tree; `keep.has` stops early and a visited guard stops a corrupt parent cycle.
    let cur: T | undefined = c;
    const seen = new Set<string>();
    while (cur && !keep.has(cur.id) && !seen.has(cur.id)) {
      seen.add(cur.id);
      keep.add(cur.id);
      cur = cur.parentId ? byId.get(cur.parentId) : undefined;
    }
  }
  return categories.filter(c => keep.has(c.id));
}
