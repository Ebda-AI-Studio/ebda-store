/**
 * STORE-QA-74: the order-based revenue figures (finance "Net sales", the analytics dashboard KPIs, the Customers spend strip) are
 * cached for up to 120 s / 300 s. After a refund the ledger tiles moved at once while these stayed on the old number until the
 * TTL (or a later write) because no write path invalidated them.
 *
 * STALENESS CLASS: money totals shown to the merchant are NEVER-stale. Event invalidation on EVERY write path, every layer:
 * the cache entry is dropped through the generation-guarded prefix bust (Redis + the in-memory fallback + any in-flight fill, so
 * a fill that read the pre-write numbers cannot republish them). The one choke point every order / payment / refund / return /
 * status write of a Durable Object store passes through is the money-op transport (`repo-factory.ts` `callMoney`), so this is
 * called there after the op committed, not from each of the ~50 call sites.
 */
import logger from './logger';

/** Cache key prefix of the analytics dashboard payload of ONE store (every date range). */
export const analyticsDashboardPrefix = (storeId: string): string =>
  `analytics:dashboard:${storeId}:`;

/**
 * Money ops that only READ (or that never touch an order's money): everything else is treated as a possible revenue change, so a
 * newly added write op is covered by default (over-invalidating only costs one recompute, never a stale figure).
 */
const READ_ONLY_MONEY_OP =
  /^(analytics|search|loyalty(CustomerPoints|History|Members|Stats|StoreTransactions|ImportState)$|receipt(Get|List)$|trialBalance$|periodGlCredits$|accountTotals$|stockValue$|quoteOrder$|paymentIndexCheck$)/;

/**
 * The ONE write op left out on purpose: `createOrder`, the guest checkout hot path (latency budget, `workers-test/latency-budget.test.ts`:
 * the invalidation costs 2 extra remote calls and a serial wave on every order). A NEW order only ADDS to the totals and shows within
 * the 120 s TTL (BOUNDED-stale, residual: a just-placed order is missing from the dashboard for up to 2 minutes); everything that can
 * REMOVE or CHANGE a counted sale (confirm, pay, cancel, status, refund, return) still invalidates at once. Ruling REVENUE-CACHE-1.
 */
const BOUNDED_STALE_MONEY_OP = new Set(['createOrder']);

/** True when a money op (a Durable Object `moneyOp` name) can change what the revenue figures read. */
export function moneyOpMayChangeRevenue(op: string): boolean {
  return !READ_ONLY_MONEY_OP.test(op) && !BOUNDED_STALE_MONEY_OP.has(op);
}

/** Drop every cached revenue-derived figure of a store. Never throws: a Redis outage must not fail the write that already committed. */
export async function invalidateStoreRevenueCaches(storeId: string): Promise<void> {
  // lazy: `repo-factory` (imported by nearly everything) must not statically pull the public-cache module chain
  const { invalidateCachedPrefix, invalidateCustomersCache } = await import('./public-cache.js');
  const results = await Promise.allSettled([
    invalidateCachedPrefix(analyticsDashboardPrefix(storeId)),
    invalidateCustomersCache(storeId),
  ]);
  for (const r of results)
    if (r.status === 'rejected')
      logger.warn(
        { err: r.reason, storeId },
        '[revenue-cache] invalidation failed; the TTL bounds the stale window'
      );
}
