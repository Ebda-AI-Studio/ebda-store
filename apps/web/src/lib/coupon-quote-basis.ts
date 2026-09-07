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
export function couponQuoteBasis(
  items: ReadonlyArray<{ price: number; quantity: number }>
): number {
  return items.reduce((sum, item) => sum + item.price * item.quantity, 0);
}
