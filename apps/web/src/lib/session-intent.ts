/**
 * Audit 2026-11-03 #15 (console noise): a guest's every page load asked `/auth/me` and logged a red
 * 401 (plus a `/auth/refresh` 401 for the once-per-tab Safari probe). A browser with no JS-visible
 * session hint (`hasSessionHint`, lib/api.ts) now asks the API who it is only on the routes where
 * knowing changes what the shopper sees: the places a signed-in customer acts on their account or
 * their order. Everywhere else (home, listing, PDP, blog, search) it is a guest and makes no call.
 *
 * Matches by path SEGMENT, after any store prefix or locale (`/ar/cart`, `/s/my-store/en/account/x`),
 * so `/products/cart-cover` is not the cart.
 */
const SESSION_INTENT_SEGMENTS = new Set([
  'cart',
  'checkout',
  'account',
  'wishlist',
  'auth',
  'returns',
  'track',
]);

export function isSessionIntentPath(pathname: string | null | undefined): boolean {
  if (!pathname) return false;
  const segs = pathname.toLowerCase().split('/').filter(Boolean);
  // `/products/<slug>`: everything after a products/blog segment is a handle, not a route name.
  const stop = segs.findIndex(s => s === 'products' || s === 'blog' || s === 'categories');
  const route = stop === -1 ? segs : segs.slice(0, stop);
  return route.some(s => SESSION_INTENT_SEGMENTS.has(s));
}
