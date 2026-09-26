/**
 * What removing a coupon must do to the shipping line, in order (#1807).
 *
 * A free-shipping coupon leaves `freeShipping = true` and `shippingCost = 0`
 * behind. Recomputing shipping is an async POST, and the summary total reads
 * `freeShipping ? 0 : shippingCost` — so for the whole round-trip the page
 * still showed free delivery while Place Order was clickable, and an order
 * placed in that window was charged a delivery fee the customer was never
 * shown. So: drop the coupon's free-shipping flag at once, hold the submit
 * gate closed, and release it only once the recomputed fee has landed.
 */
export async function repriceAfterCouponRemoval(deps: {
  setFreeShipping: (value: boolean) => void;
  setRepricing: (value: boolean) => void;
  calculateShipping: () => Promise<void>;
}): Promise<void> {
  deps.setFreeShipping(false);
  deps.setRepricing(true);
  try {
    await deps.calculateShipping();
  } finally {
    deps.setRepricing(false);
  }
}
