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
  count: number,
  names: readonly string[] = []
): string {
  // NAME the items when we can.
  //
  // The count alone only ever picked singular-vs-plural copy, which left a
  // customer with a six-item cart removing lines by guess-and-check and
  // re-entering checkout after each one — on the flow that became routine the
  // moment soft delete started tripping this refusal. The server sends the
  // offending ids in `details.productIds`; a raw UUID means nothing to a
  // shopper, but the cart already holds the matching line, so the caller
  // resolves ids to names and the message can say which ones.
  //
  // Names are appended rather than interpolated into the sentence: the
  // sentence is translated and a product name is not, so splicing one into
  // Arabic copy would read as a mixed-direction fragment mid-clause. A
  // trailing clause keeps both halves intact in either language.
  const named = names.filter(nm => nm.trim().length > 0);
  const base =
    count > 1
      ? t(
          'Some items in your cart are no longer sold. Please remove them from your cart to continue.',
          'بعض المنتجات في سلتك لم تعد متوفرة. يرجى إزالتها من السلة للمتابعة.'
        )
      : t(
          'An item in your cart is no longer sold. Please remove it from your cart to continue.',
          'أحد المنتجات في سلتك لم يعد متوفراً. يرجى إزالته من السلة للمتابعة.'
        );

  if (named.length === 0) return base;

  // The ids did not all resolve — say only what is true, and let the generic
  // sentence carry the rest. Claiming a complete list when it is partial is
  // worse than not listing at all: the customer removes what is named, retries,
  // and meets the same refusal.
  const complete = named.length === count;
  const label = complete ? t('Remove:', 'يرجى إزالة:') : t('Including:', 'من بينها:');

  return `${base} ${label} ${named.join(t(', ', '، '))}`;
}
