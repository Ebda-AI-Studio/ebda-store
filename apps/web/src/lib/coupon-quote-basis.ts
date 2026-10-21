/**
 * The basis a COUPON is quoted against at `POST /coupons/validate`: the sum
 * of LOOSE cart lines only, never a bundle's price.
 *
 * `OrderService.create` applies a coupon to `cart.items` alone (Ruling B1 —
 * a coupon never stacks onto an already-discounted box), so quoting against
 * a bundle-inclusive total promised a discount the server then refused to
 * apply in full, and the customer was shown a bigger discount than they were
 * actually charged (P0-1, final review). Identical to the cart's whole
 * subtotal for a cart with no bundle.
 *
 * Extracted from `CheckoutClient.tsx`/`CartClient.tsx` (P2-c, scoped
 * re-review): both components had their own inline `couponBasis` definition,
 * guarded only by a source-text test asserting the string
 * `${itemsVar}.reduce` was present — which stays green even if someone edits
 * the reduce to `sum + item.price` (dropping `* item.quantity`), silently
 * re-opening display≠charge for any loose line with quantity > 1. One
 * implementation, tested on real arithmetic, removes that hole.
 */
export function couponQuoteBasis(items: ReadonlyArray<CouponQuoteLine>): number {
  // #1766: a line whose product was deleted is not in the cart total and can
  // never be ordered, so it is not part of what a coupon is quoted against.
  return items.reduce(
    (sum, item) => (couponEligible(item) ? sum + item.price * item.quantity : sum),
    0
  );
}

/** A cart line as the quote sees it. `priceSource` is the SERVER's provenance for the line's price (B2B). */
export interface CouponQuoteLine {
  price: number;
  quantity: number;
  unavailable?: boolean;
  priceSource?: 'base' | 'tier' | 'group';
}

/**
 * Ruling B2B-5, mirrored from the server so the quote equals the charge: a line priced by a quantity tier or a wholesale group
 * price is excluded from every coupon basis (`OrderService.create` builds its coupon basis from base-priced lines only). A line
 * with no `priceSource` (an older API response) is treated as base-priced.
 */
export function couponEligible(item: {
  unavailable?: boolean;
  priceSource?: 'base' | 'tier' | 'group';
}): boolean {
  return !item.unavailable && (item.priceSource === undefined || item.priceSource === 'base');
}

/**
 * The same loose lines, as the `cartItems` the validate route evaluates
 * targeting against (product/category scope, minimum quantity, customer group,
 * first order). Without them the route fell back to the whole-cart
 * `orderTotal` math and evaluated no targeting at all, so a scoped or
 * first-order-only code — free-shipping ones included — was shown as applied
 * and then refused at order creation with COUPON_NOT_ELIGIBLE (#1368, #1379).
 * Category ids are resolved server-side; the storefront cart does not carry
 * them. `Σ lineTotal === couponQuoteBasis(items)` by construction.
 */
export function couponQuoteCartItems(
  items: ReadonlyArray<CouponQuoteLine & { productId: string }>
): Array<{ productId: string; quantity: number; lineTotal: number }> {
  return items.filter(couponEligible).map(item => ({
    productId: item.productId,
    quantity: item.quantity,
    lineTotal: item.price * item.quantity,
  }));
}

/**
 * The WHOLE loose cart (tier / group priced lines included, unavailable lines excluded) for the validate route's
 * free-shipping judgement (Ruling B2B-M2, final review P2-3): a free-shipping code acts on the shipping line, so
 * `OrderService.create` checks its minimum, quantity and scope against every loose line, not only the base-priced ones.
 * Spread into every `POST /coupons/validate` body next to `orderTotal` / `cartItems`.
 */
export function couponQuoteLooseFields(
  items: ReadonlyArray<CouponQuoteLine & { productId: string }>
): {
  looseOrderTotal: number;
  looseCartItems: Array<{ productId: string; quantity: number; lineTotal: number }>;
} {
  const loose = items.filter(item => !item.unavailable);
  return {
    looseOrderTotal: loose.reduce((sum, item) => sum + item.price * item.quantity, 0),
    looseCartItems: loose.map(item => ({
      productId: item.productId,
      quantity: item.quantity,
      lineTotal: item.price * item.quantity,
    })),
  };
}
