/**
 * Business-rule error classification for the bundle add-to-cart call
 * (`POST /public/cart/bundles`, see `CartContext.addBundle`).
 *
 * That route refuses a business-rule violation with a flat
 * `{ error: '<code>' }` 422 body (see the route's own doc comment in
 * `apps/api/src/routes/public.routes.ts`) — NOT this app's usual
 * `{ code, message }` error envelope. `ApiClient.request` still assigns
 * that raw string into `ApiResponse.error` (typed as an object, but a
 * string at runtime for THIS one route), so `classifyBundleCartError` reads
 * it via `String(...)` rather than an unsafe cast, and works the same way
 * whether it's handed the raw string or (for any other route/failure) an
 * `{code,message}` object or `undefined`.
 *
 * Extracted to a pure function specifically so this mapping is unit-testable
 * without rendering `CartProvider` — this repo has no DOM-rendering test
 * harness installed (no jsdom/testing-library anywhere in the monorepo), so
 * every other React-adjacent test here also tests the underlying pure logic
 * directly rather than mounting a component.
 */
export type BundleCartErrorCode = 'bundle_not_purchasable' | 'insufficient_stock' | 'unknown';

export function classifyBundleCartError(rawError: unknown): BundleCartErrorCode {
  const code = String(rawError ?? '');
  if (code === 'bundle_not_purchasable') return 'bundle_not_purchasable';
  if (code === 'insufficient_stock') return 'insufficient_stock';
  return 'unknown';
}

/**
 * Toast copy for each classified code. `t` is `LanguageContext`'s
 * `(en, ar) => string` locale picker — same signature every other toast
 * call site in this app already uses.
 *
 * A customer must never see the generic "something went wrong" copy for a
 * condition the API named precisely: `bundle_not_purchasable` (inactive,
 * expired, or zero availability) and `insufficient_stock` (the requested
 * quantity exceeds what's left) each get their own message; only a truly
 * unclassified failure (network error, an unexpected 4xx/5xx) falls back to
 * the generic "please try again" copy.
 */
export function bundleCartErrorCopy(
  code: BundleCartErrorCode,
  t: (en: string, ar: string) => string
): { title: string; message: string } {
  switch (code) {
    case 'bundle_not_purchasable':
      return {
        title: t('Bundle unavailable', 'الباقة غير متاحة'),
        message: t(
          'This bundle is no longer available for purchase.',
          'الباقة دي مبقتش متاحة للشراء.'
        ),
      };
    case 'insufficient_stock':
      return {
        title: t('Not enough stock', 'الكمية غير متوفرة'),
        message: t(
          'Not enough stock to add this quantity right now.',
          'الكمية المطلوبة مش متوفرة دلوقتي.'
        ),
      };
    default:
      return {
        title: t('Unable to add to cart', 'الإضافة للسلة منفعتش'),
        message: t('Please try again.', 'جرّب تاني.'),
      };
  }
}
