import type { CartItem } from './CartContext';

/**
 * Pure helpers for the cart hydration path.
 *
 * CartContext's hydrate() was flagged at 19 branches. Two of its concerns are
 * pure data handling that can be tested directly, unlike the effect itself:
 * reading the offline cart out of localStorage, and shaping it for the sync
 * call. Both sit on the path a shopper's cart takes when they return to a store,
 * so a silent mistake here loses a basket.
 */

/**
 * Read the locally-persisted cart.
 *
 * Deliberately total: storage can be disabled (Safari private mode), the value
 * can be absent, or it can be corrupt JSON from an older schema. None of those
 * should throw on the hydration path — the shopper just gets an empty local cart
 * and the server copy wins.
 *
 * A non-array payload is rejected rather than trusted: older builds stored a
 * different shape, and passing that to .filter/.map downstream would throw.
 */
export function readLocalCart(storageKey: string): CartItem[] {
  try {
    const saved = localStorage.getItem(storageKey);
    if (!saved) return [];
    const parsed = JSON.parse(saved);
    return Array.isArray(parsed) ? (parsed as CartItem[]) : [];
  } catch {
    return [];
  }
}

/**
 * Shape a local cart for the server sync call.
 *
 * Drops entries with no usable product id or a non-positive quantity — those
 * cannot be synced and would be rejected server-side anyway. `productId || id`
 * mirrors CartItem's documented fallback: before the first server round-trip,
 * `id` holds the productId so optimistic UI has a stable key.
 */
export function toSyncPayload(
  localItems: CartItem[]
): Array<{ productId: string; quantity: number; variantId?: string }> {
  return localItems
    .filter(i => (i.productId || i.id) && i.quantity > 0)
    .map(i => ({
      productId: (i.productId || i.id) as string,
      quantity: i.quantity,
      variantId: i.variantId,
    }));
}
