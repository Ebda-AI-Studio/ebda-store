import type { ProductCardProps } from '../types';

/**
 * Equality comparator for memoizing ProductCard components.
 *
 * Parents (e.g. ProductGrid) recreate handler props on every render. With
 * default shallow comparison, those new function references would force a
 * re-render of every card on unrelated parent state changes. We instead
 * compare the value-shaped props that actually affect render output:
 *
 * - product.id (identity)
 * - quantityInCart (drives the quantity badge)
 * - isInCompare (drives the compare-toggle styling)
 * - isRtl, currency, urlPrefix (context that changes appearance)
 *
 * The handlers themselves are intentionally excluded — re-rendering when a
 * parent re-renders just because it created a new closure is exactly what
 * this memo is designed to skip.
 */
export function productCardPropsEqual(
  prev: Readonly<ProductCardProps>,
  next: Readonly<ProductCardProps>
): boolean {
  if (prev.product.id !== next.product.id) return false;
  if ((prev.quantityInCart ?? 0) !== (next.quantityInCart ?? 0)) return false;
  if ((prev.isInCompare ?? false) !== (next.isInCompare ?? false)) return false;
  if ((prev.isRtl ?? false) !== (next.isRtl ?? false)) return false;
  if (prev.currency !== next.currency) return false;
  if (prev.urlPrefix !== next.urlPrefix) return false;
  // Compare image identity by url + length to catch product image swaps
  // without comparing the whole object array shallowly.
  const prevImg = prev.product.images?.[0]?.url;
  const nextImg = next.product.images?.[0]?.url;
  if (prevImg !== nextImg) return false;
  if ((prev.product.images?.length ?? 0) !== (next.product.images?.length ?? 0)) return false;
  // Track price/compareAtPrice/inStock — these affect visual output.
  if (prev.product.price !== next.product.price) return false;
  if (prev.product.compareAtPrice !== next.product.compareAtPrice) return false;
  if (prev.product.inStock !== next.product.inStock) return false;
  // Track presence (not identity) of optional handlers — when a handler
  // becomes undefined the card hides the button entirely.
  if (!!prev.onToggleCompare !== !!next.onToggleCompare) return false;
  if (!!prev.onRemoveFromWishlist !== !!next.onRemoveFromWishlist) return false;
  return true;
}
