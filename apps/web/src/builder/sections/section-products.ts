/**
 * Resolve the products a document section shows (featured-collection,
 * product-spotlight) from the pools the homepage already fetched — the same
 * rules as the product carousels: a named source picks its list, a category
 * filters the union by slug, hand-picked ids keep their order, and an empty
 * match falls back to the newest products so a configured section never
 * renders as a blank block. Prices and stock come from these API products;
 * the document only holds the reference.
 */
import type { Product } from '@/lib/api';

export interface SectionProductRefs {
  productSource?: 'newest' | 'best_seller' | 'featured' | 'category' | 'manual';
  categorySlug?: string;
  manualProductIds?: string[];
  limit?: number;
}

export interface ProductPools {
  newArrivals: Product[];
  bestSellers: Product[];
  featured: Product[];
  extra: Product[];
}

export function resolveSectionProducts(
  refs: SectionProductRefs,
  pools: ProductPools,
  fallbackLimit: number
): Product[] {
  const limit = refs.limit ?? fallbackLimit;
  const union = new Map<string, Product>();
  for (const p of [...pools.newArrivals, ...pools.bestSellers, ...pools.featured, ...pools.extra])
    union.set(p.id, p);
  let list: Product[];
  switch (refs.productSource) {
    case 'best_seller':
      list = pools.bestSellers;
      break;
    case 'featured':
      list = pools.featured;
      break;
    case 'category': {
      const slug = (refs.categorySlug ?? '').toLowerCase();
      list = slug
        ? [...union.values()].filter(p =>
            (p.categories ?? []).some(c => (c?.category?.slug ?? '').toLowerCase() === slug)
          )
        : [];
      break;
    }
    case 'manual':
      list = (refs.manualProductIds ?? [])
        .map(id => union.get(id))
        .filter((p): p is Product => !!p);
      break;
    default:
      list = pools.newArrivals;
  }
  if (list.length === 0) list = pools.newArrivals.length > 0 ? pools.newArrivals : pools.featured;
  return list.slice(0, limit);
}
