/**
 * Once-per-order guard for the browser Purchase pixel (#1346).
 *
 * The success page used to guard with component state, which resets on every
 * remount: a refresh, a back-navigation or re-opening the success link from an
 * email re-fired `trackPurchase` for an order already counted. Meta and TikTok
 * de-duplicate on the order id, but Twitter/Pinterest/Snap have no dedup key,
 * so each refresh was another reported sale there.
 *
 * `localStorage` (not sessionStorage) so the guard survives the tab being
 * closed and the link re-opened later. Storage can be unavailable (private
 * mode, blocked site data) — then an in-memory set still stops repeat fires
 * within the page's lifetime, which is the old behaviour at worst.
 *
 * Read and write are SEPARATE on purpose: the marker means "a pixel received
 * this order", not "we tried". The caller checks `hasPurchasePixelFired`,
 * calls `trackPurchase`, and marks only when `trackPurchase` reports that a
 * pixel library was present. A first visit before marketing consent loads no
 * pixels at all, so marking up front would lose the order for good once the
 * shopper accepts cookies and the page reloads.
 */
const KEY_PREFIX = 'force:purchase-pixel-fired:';
const firedThisPage = new Set<string>();

/** True when this order's Purchase pixel already reached a pixel library. */
export function hasPurchasePixelFired(orderId: string): boolean {
  if (!orderId) return true; // nothing to report without an id
  if (firedThisPage.has(orderId)) return true;
  try {
    return window.localStorage.getItem(KEY_PREFIX + orderId) !== null;
  } catch {
    // Storage unavailable — the in-memory set above is the guard.
    return false;
  }
}

/** Record that this order's Purchase pixel reached a pixel library. */
export function markPurchasePixelFired(orderId: string): void {
  if (!orderId) return;
  firedThisPage.add(orderId);
  try {
    window.localStorage.setItem(KEY_PREFIX + orderId, String(Date.now()));
  } catch {
    // Storage unavailable — the in-memory set above is the guard.
  }
}

/**
 * Report a confirmed order's Purchase pixel at most once per browser.
 * `track` is `trackPurchase`, which returns whether any pixel was present;
 * the order is marked only then.
 */
export function firePurchasePixelOnce(orderId: string, track: () => boolean): boolean {
  if (hasPurchasePixelFired(orderId)) return false;
  const fired = track();
  if (fired) markPurchasePixelFired(orderId);
  return fired;
}
