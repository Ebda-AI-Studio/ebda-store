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
 *
 * `calculateShipping` never throws in production — it swallows both a non-2xx
 * answer and a network error into `shippingError` (#2067). So it reports
 * whether a quote actually LANDED, and this returns that answer. Releasing
 * `repricing` on a failed quote is safe only because `shippingError` is
 * itself a submit gate (`isShippingSettled` below): the gate the customer
 * sees closes on "we do not know the fee", not merely on "a request is in
 * flight".
 */
export async function repriceAfterCouponRemoval(deps: {
  setFreeShipping: (value: boolean) => void;
  setRepricing: (value: boolean) => void;
  calculateShipping: () => Promise<boolean>;
}): Promise<boolean> {
  deps.setFreeShipping(false);
  deps.setRepricing(true);
  try {
    return await deps.calculateShipping();
  } finally {
    deps.setRepricing(false);
  }
}

/**
 * Is the delivery fee on screen the one the order will be charged? (#2067)
 *
 * False while a quote is in flight (a stale fee from the previous area or a
 * removed free-shipping coupon is still displayed) and after a quote FAILED
 * (the displayed fee was never confirmed). Both the step-1 "Continue" and the
 * step-2 Place Order gate on this, as does `handleSubmit` itself.
 */
export function isShippingSettled(state: {
  shippingError: boolean;
  quotePending: boolean;
  repricing: boolean;
}): boolean {
  return !state.shippingError && !state.quotePending && !state.repricing;
}
