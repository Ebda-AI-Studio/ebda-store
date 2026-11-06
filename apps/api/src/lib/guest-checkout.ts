import { storeDb } from './repo-factory';

/**
 * Whether a store takes GUEST orders (no customer account), within a window.
 *
 * Metrics built on `abandoned_carts` — abandoned-cart counts, and the funnel's
 * "checkouts started" / "orders abandoned" — cannot see a guest cart: detection
 * needs the cart's customer contact, and a guest cart has none (owner decision
 * 2026-09-30: no guest contact capture at checkout). On a store that takes
 * guest orders those metrics read 0 for a reason that has nothing to do with
 * the shop, so the admin shows them as "not tracked for guest checkout"
 * instead of a false 0 (2026-09-30 analytics audit, finding 3).
 *
 * One indexed probe (`orders(store_id, customer_id)`). Callers inside a request
 * already run in the store's tenant context.
 */
export async function storeTakesGuestOrders(storeId: string, since: Date): Promise<boolean> {
  // The store's backend (a DO store's orders are in its StoreDO; the prisma proxy for a pg store).
  const row = await (
    await storeDb(storeId)
  ).order.findFirst({
    where: { storeId, customerId: null, createdAt: { gte: since } },
    select: { id: true },
  });
  return row !== null;
}

/** Look-back used when a surface has no window of its own (abandoned-cart stats). */
export const GUEST_CHECKOUT_LOOKBACK_DAYS = 90;
