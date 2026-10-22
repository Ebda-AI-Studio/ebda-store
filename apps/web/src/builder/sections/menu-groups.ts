import type { Product } from '@/lib/api';

/** A category as the menu needs it: id, slug and both names, in the merchant's category order. */
export interface MenuCategory {
  id: string;
  slug: string;
  name: string;
  nameAr?: string | null;
}

export interface MenuGroup {
  /** Stable anchor key: the category slug, or `other` for dishes in no listed category. */
  key: string;
  category: MenuCategory | null;
  products: Product[];
}

/**
 * Ruling B4-1: a menu lists dishes grouped by the store's categories, in the MERCHANT's category
 * order (the order of `categories`, never alphabetical). A dish sits under the first category in
 * that order that holds it, so it is listed once. A dish in no listed category goes to a trailing
 * `other` group instead of vanishing. A category with no dish in the pool makes no group (so no
 * empty tab); a single group makes no tabs (the caller decides from `groups.length`).
 */
export function groupMenuProducts(
  products: readonly Product[],
  categories: readonly MenuCategory[]
): MenuGroup[] {
  const placed = new Set<string>();
  const groups: MenuGroup[] = [];
  for (const category of categories) {
    const slug = category.slug.toLowerCase();
    const inCategory = products.filter(
      p =>
        !placed.has(p.id) &&
        (p.categories ?? []).some(c => (c?.category?.slug ?? '').toLowerCase() === slug)
    );
    if (inCategory.length === 0) continue;
    for (const p of inCategory) placed.add(p.id);
    groups.push({ key: category.slug, category, products: inCategory });
  }
  const rest = products.filter(p => !placed.has(p.id));
  if (rest.length > 0) groups.push({ key: 'other', category: null, products: rest });
  return groups;
}
