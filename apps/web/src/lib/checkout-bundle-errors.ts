/**
 * Checkout-time bundle failure copy — distinct from `bundle-cart-errors.ts`
 * (which classifies the ADD-TO-CART route's flat-string business-rule
 * refusals). This file handles the CHECKOUT (`POST /orders`) failure
 * codes, which arrive in this app's usual `{code, message}` envelope (see
 * `CheckoutClient.tsx`'s `orderResult.error`).
 *
 * `OrderService.create` (order.service.ts) already names the specific
 * bundle in its `AppError` message for both failure classes:
 *
 *   - `BUNDLE_NOT_PURCHASABLE` (409): a bundle that was purchasable when
 *     added to the cart is no longer sellable (deactivated, expired, or
 *     sold out) by the time checkout runs.
 *       `"${resolved.name}" is no longer available. Remove it from your
 *       cart and try again.`
 *   - `INSUFFICIENT_INVENTORY` (400): shared by loose cart items AND
 *     bundle-component lines. A bundle-component shortfall is the ONLY
 *     case whose message contains `(component of "...")` — a plain
 *     product's stock failure never does, so that phrase is what
 *     distinguishes a bundle-caused stock failure without a separate
 *     error code.
 *       `Not enough inventory for ${productName} (component of
 *       "${bundleName}")`
 *
 * Before this file, CheckoutClient's error switch had no `case` for
 * `BUNDLE_NOT_PURCHASABLE` at all (silent fallthrough to the fully generic
 * "Something went wrong" copy), and its `INSUFFICIENT_INVENTORY` case
 * ("one of the items in your cart is out of stock") never named which box
 * was the problem. Both leave the customer with nothing actionable and
 * generate a support message instead.
 *
 * Extracted as a pure function (same rationale as bundle-cart-errors.ts):
 * this repo has no DOM-rendering test harness, so the mapping is unit
 * tested directly rather than by mounting `CheckoutClient`.
 */

/**
 * Returns the bilingual, bundle-specific checkout copy for `code`, or
 * `null` when `code`/`rawMessage` doesn't describe a bundle-caused
 * failure — callers fall through to their existing generic handling for
 * `null` (this must never mis-fire on a same-coded PLAIN PRODUCT failure).
 */
export function checkoutBundleErrorCopy(
  code: string,
  rawMessage: string,
  t: (en: string, ar: string) => string
): string | null {
  if (code === 'BUNDLE_NOT_PURCHASABLE') {
    const match = /^"(.+)" is no longer available/.exec(rawMessage ?? '');
    const name = match?.[1];
    return name
      ? t(
          `"${name}" is no longer available. Please remove it from your cart and try again.`,
          `"${name}" مبقتش متاحة. شيلها من سلتك وجرّب تاني.`
        )
      : t(
          'One of the bundles in your cart is no longer available. Please remove it from your cart and try again.',
          'في باقة في سلتك مبقتش متاحة. شيلها من سلتك وجرّب تاني.'
        );
  }

  if (code === 'BUNDLE_PRICE_NOT_ALLOCATABLE') {
    // The bundle's fixed price can no longer be split exactly across its
    // components — a component's price moved after the bundle was priced. The
    // server's own message ends "Please try again", which is the one thing
    // that cannot work: the allocation will fail identically until the
    // merchant re-prices the bundle. The recovering action is to remove it.
    const match = /^"(.+)" can no longer be priced/.exec(rawMessage ?? '');
    const name = match?.[1];
    return name
      ? t(
          `"${name}" can no longer be priced correctly. Please remove it from your cart to continue.`,
          `"${name}" مبقاش ينفع نحسب سعرها صح. شيلها من سلتك عشان تكمّل.`
        )
      : t(
          'One of the bundles in your cart can no longer be priced correctly. Please remove it from your cart to continue.',
          'في باقة في سلتك مبقاش ينفع نحسب سعرها صح. شيلها من سلتك عشان تكمّل.'
        );
  }

  if (code === 'INSUFFICIENT_INVENTORY') {
    // A plain product's INSUFFICIENT_INVENTORY message never contains
    // "component of" — only a bundle-component shortfall does (see the
    // file doc comment above) — so returning `null` here for a
    // non-matching message correctly falls through to the existing
    // generic per-product copy, never mis-firing on a same-code plain
    // product failure.
    const match = /component of "(.+)"\)$/.exec(rawMessage ?? '');
    const bundleName = match?.[1];
    if (!bundleName) return null;
    return t(
      `An item in the "${bundleName}" bundle just sold out. Please remove that bundle from your cart and try again.`,
      `في حاجة جوه باقة "${bundleName}" خلصت حالاً. شيل الباقة دي من سلتك وجرّب تاني.`
    );
  }

  return null;
}
