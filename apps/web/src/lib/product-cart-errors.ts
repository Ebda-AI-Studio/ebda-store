/**
 * Checkout copy for a cart line whose PRODUCT is gone — the sibling of
 * `checkout-bundle-errors.ts`, which does the same job for bundle lines.
 *
 * ## Why this file exists
 *
 * `OrderService.create` refuses with `PRODUCT_NO_LONGER_AVAILABLE` (409) when a
 * cart line resolves to no live product. That guard used to be near-dead code:
 * it only caught a HARD delete, and `ProductService.delete` never hard-deletes
 * — it sets `deletedAt` and leaves `status: 'active'`.
 *
 * Scoping the checkout lookup to `deletedAt: null` made the refusal correct AND
 * routine: soft delete is the admin "delete product" button, and carts persist
 * for days (the abandoned-cart feature depends on it). So a merchant deleting a
 * product now trips this for every live cart holding it.
 *
 * `CheckoutClient`'s switch had no case for the code, so those customers fell
 * to the generic "Something went wrong... please try again" — advice that can
 * never succeed. Fixing the server half without this one turns a silent bug
 * into a visible dead end, which is worse for the shopper.
 */

/** The API's error envelope, narrowed to what this module reads. */
export interface ProductUnavailableError {
  code?: string;
  details?: { productIds?: unknown } | null;
}

export const PRODUCT_NO_LONGER_AVAILABLE = 'PRODUCT_NO_LONGER_AVAILABLE';

/** True when this failure is "a product in the cart no longer exists". */
export function isProductUnavailableError(
  err: ProductUnavailableError | null | undefined
): boolean {
  return err?.code === PRODUCT_NO_LONGER_AVAILABLE;
}

/**
 * The offending product ids, if the API sent them.
 *
 * Defensive because `details` crosses a network boundary: it is typed on the
 * server and arbitrary here. A malformed payload yields an empty list — the
 * copy still works, the cart just cannot highlight specific lines.
 */
export function unavailableProductIds(err: ProductUnavailableError | null | undefined): string[] {
  if (!isProductUnavailableError(err)) return [];
  const raw = err?.details?.productIds;
  if (!Array.isArray(raw)) return [];
  return raw.filter((v): v is string => typeof v === 'string' && v.length > 0);
}

/**
 * Bilingual copy. Takes the caller's `t(en, ar)` so the strings live with
 * every other user-facing string rather than being hardcoded here, and so
 * this module stays framework-free and directly testable.
 *
 * Deliberately does NOT name the product: the server sends ids, not names, and
 * a UUID is worse than no detail. The cart page marks the lines instead.
 */
export function productUnavailableCopy(
  t: (en: string, ar: string) => string,
  count: number
): string {
  return count > 1
    ? t(
        'Some items in your cart are no longer sold. Please remove them from your cart to continue.',
        'بعض المنتجات في سلتك لم تعد متوفرة. يرجى إزالتها من السلة للمتابعة.'
      )
    : t(
        'An item in your cart is no longer sold. Please remove it from your cart to continue.',
        'أحد المنتجات في سلتك لم يعد متوفراً. يرجى إزالته من السلة للمتابعة.'
      );
}
