/**
 * Utilities for recording and retrieving the shopper's last-browsed listing
 * (category/PLP) URL so the "Continue Shopping" button can return them there
 * instead of always landing on the generic /products page.
 *
 * Keys are namespaced per-store (same pattern as the cart key in CartContext)
 * so path-based multi-tenant stores sharing one origin don't bleed each
 * other's last-listing into a sibling's cart.
 *
 * sessionStorage is used (not localStorage) so the memory is scoped to the
 * browser tab. Opening a second tab to a different store starts fresh.
 */

const LAST_LISTING_KEY_PREFIX = 'force-store-last-listing';

/**
 * Returns the per-store sessionStorage key for the last-listing URL.
 * Falls back to a generic key when storeId is unknown (e.g. demo context).
 */
export function lastListingKeyFor(storeId: string | undefined): string {
  return storeId && storeId !== 'demo'
    ? `${LAST_LISTING_KEY_PREFIX}:${storeId}`
    : LAST_LISTING_KEY_PREFIX;
}

/**
 * Persist the current listing path (pathname + search) to sessionStorage.
 * Only call from actual listing pages (products/categories) — never from
 * cart, checkout, PDP, or account pages.
 *
 * The `rawPath` must be the **store-relative** path (e.g. `/products?category=chocolate`),
 * NOT the platform-prefixed one (`/<slug>/products?...`). It is stored
 * store-relative and reconstructed through `storeUrl()` on read so it works
 * on both the platform host and custom domains.
 */
export function recordLastListing(storeId: string | undefined, rawPath: string): void {
  if (typeof window === 'undefined') return;
  try {
    sessionStorage.setItem(lastListingKeyFor(storeId), rawPath);
  } catch {
    // sessionStorage can be blocked by privacy settings — degrade silently.
  }
}

/**
 * Read back the last-recorded listing path for this store.
 * Returns the raw store-relative path (e.g. `/products?category=chocolate`)
 * or `null` when nothing has been recorded yet.
 *
 * Callers must pass the result through `storeUrl()` before using it as an
 * href to get the correct platform-prefix/custom-domain form.
 */
export function getLastListing(storeId: string | undefined): string | null {
  if (typeof window === 'undefined') return null;
  try {
    return sessionStorage.getItem(lastListingKeyFor(storeId));
  } catch {
    return null;
  }
}
