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
  productSource?: 'newest' | 'best_seller' | 'featured' | 'on_sale' | 'category' | 'manual';
  categorySlug?: string;
  manualProductIds?: string[];
  limit?: number;
  /** A `stage` spotlight shows ONE hand-picked product or nothing (no newest fallback). */
  layout?: string;
}

export interface ProductPools {
  newArrivals: Product[];
  bestSellers: Product[];
  featured: Product[];
  extra: Product[];
}

interface SaleVariant {
  price?: number | null;
  compareAtPrice?: number | null;
  isActive?: boolean;
}
interface SaleProduct {
  id: string;
  price: number;
  compareAtPrice?: number | null;
  variants?: SaleVariant[];
}

/**
 * How far a product's price has dropped, 0 = not on sale. Same rule as getProductPricing and the
 * API's `sort=on_sale` statement: a product with variants is on sale only through a variant whose
 * own compare-at exceeds its own price (the parent's compare-at is stale data and ignored);
 * a product without variants through its own compare-at. Returned as a fraction (biggest drop
 * first = descending).
 */
export function saleDiscount(p: SaleProduct): number {
  const variants = p.variants ?? [];
  if (variants.length > 0) {
    let best = 0;
    for (const v of variants) {
      if (v.isActive === false) continue;
      if (typeof v.price === 'number' && typeof v.compareAtPrice === 'number') {
        if (v.compareAtPrice > v.price) best = Math.max(best, 1 - v.price / v.compareAtPrice);
      }
    }
    return best;
  }
  return p.compareAtPrice && p.compareAtPrice > p.price ? 1 - p.price / p.compareAtPrice : 0;
}

/** The products of `list` that are on sale, biggest drop first (ties keep the input order). */
export function onSaleProducts<T extends SaleProduct>(list: readonly T[]): T[] {
  return list
    .map((p, i) => ({ p, i, d: saleDiscount(p) }))
    .filter(x => x.d > 0)
    .sort((a, b) => b.d - a.d || a.i - b.i)
    .map(x => x.p);
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
    case 'on_sale':
      // Unlike the other sources there is NO newest fallback below for an empty deals row: a
      // "deals" section that shows full-price products is a lie, so it renders nothing.
      return onSaleProducts([...union.values()]).slice(0, limit);
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
      // An unfilled stage renders nothing: three stages that all fell back to the newest product
      // would show the same product three times.
      if (refs.layout === 'stage') return list.slice(0, limit);
      break;
    default:
      list = pools.newArrivals;
  }
  if (list.length === 0) list = pools.newArrivals.length > 0 ? pools.newArrivals : pools.featured;
  return list.slice(0, limit);
}

/** One `?ids=` request carries at most this many ids (the public route's page cap). */
export const MANUAL_IDS_PER_FETCH = 50;

/** Split ids into requests of at most `size`, so no referenced id is dropped past the cap. */
export function idChunks(ids: readonly string[], size = MANUAL_IDS_PER_FETCH): string[][] {
  const out: string[][] = [];
  for (let k = 0; k < ids.length; k += size) out.push(ids.slice(k, k + size));
  return out;
}
