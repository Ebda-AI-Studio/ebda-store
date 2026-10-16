/**
 * Can this be bought right now? — ONE answer for every buy surface (X-02/X-03,
 * Lookbook/Vitrine taste gate 2026-10-15).
 *
 * Buyable = in stock OR accepting backorders (a pre-order), and published.
 * The variant selector, the PDP buy button and sticky bars, every card path
 * and the delivery-date line read THIS, so they can never disagree. Before it,
 * the selector disabled every out-of-stock size even when the merchant accepted
 * backorders (the PDP showed "Pre-order" for a size nobody could pick), and the
 * delivery line promised a date on a product that could not be bought.
 *
 * Stock flags come from the server (`enrichStockFlags`: a disabled variant is
 * neither in stock nor backorderable; a variant's `acceptsBackorder` already
 * folds in the product's flag). A payload without the boolean falls back to
 * `inventory`, where null/undefined means "not tracked" = available.
 */

export interface BuyableVariant {
  inventory?: number | null;
  inStock?: boolean | null;
  acceptsBackorder?: boolean | null;
}

export interface BuyableProduct {
  inventory?: number | null;
  inStock?: boolean | null;
  acceptsBackorder?: boolean | null;
  /** Present on some payloads (wishlist); anything but `active` is not for sale. */
  status?: string | null;
}

function hasStock(x: { inStock?: boolean | null; inventory?: number | null }): boolean {
  if (typeof x.inStock === 'boolean') return x.inStock;
  return x.inventory === undefined || x.inventory === null || x.inventory > 0;
}

/** On-hand stock only (no backorder): drives "in stock" vs "pre-order" wording. */
export function inStockNow(
  product: BuyableProduct | null | undefined,
  variant?: BuyableVariant | null
): boolean {
  if (variant) return hasStock(variant);
  return product ? hasStock(product) : false;
}

/**
 * Stock OR backorder, on a published product. With a variant, the variant
 * decides (its flags already include the product's backorder setting).
 */
export function canBuyNow(
  product: BuyableProduct | null | undefined,
  variant?: BuyableVariant | null
): boolean {
  if (product?.status != null && product.status !== 'active') return false;
  const target = variant ?? product;
  if (!target) return false;
  return hasStock(target) || target.acceptsBackorder === true;
}
