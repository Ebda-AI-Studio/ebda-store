import type { JobDef } from '../../jobs/types';
import { ORDER_PURGE_EVENT, purgeStorefrontProductsNow } from '../../public-cache';
import { inngest } from '../client';

/** Event sent by `invalidateStoreProductCachesAfterOrder` on EVERY order (#663); defined once in public-cache.ts. */
// pq-allow(unused-export): re-exported for tests
export { ORDER_PURGE_EVENT };

/**
 * Durable trailing purge of a store's storefront product/category/bundle caches after orders (#663).
 *
 * The in-request purge is leading-edge and the in-isolate coalescing window is best-effort (a Worker may drop its
 * timer; `waitUntil` lives 30 s and is tied to the request that registered it). This job is the guarantee: a
 * per-store DEBOUNCED queue message, so it runs once, 10 s after the LAST order of a burst, in its own queue
 * invocation with its own retry budget, whatever happened to the requests that placed the orders.
 *
 * STALENESS CLASS: inventory is NEVER-stale. Residual window (measured from the config, #739 review): a quiet store
 * purges 10 s after its last order; under SUSTAINED traffic (an order at least every 10 s) the debounce keeps sliding
 * and the durable purge fires at the 20 s timeout. So the bound is <= 20 s after the first unpurged order, plus one
 * retry on a failed purge (~7 s): <= ~27 s. The in-request leading-edge purge usually shows the first order of a burst
 * sooner; it is best-effort and NOT counted. A fill right after the purge can still carry the API's KV L1 lag
 * (<= 60 s, NZ-D1), unchanged by this job.
 */
export const storefrontOrderPurge: JobDef = inngest.createFunction(
  {
    id: 'storefront-order-purge',
    name: 'Storefront: trailing product-cache purge after orders',
    retries: 1,
    // timeout 20 s (was 1 m): under sustained traffic the trailing purge fires every 20 s, the documented bound
    debounce: { key: 'event.data.storeId', period: '10s', timeout: '20s' },
    triggers: [{ event: ORDER_PURGE_EVENT }],
  },
  async ({ event, step }) => {
    const storeId = String(event.data?.storeId ?? '');
    if (!storeId) return { skipped: 'no-store' };
    const outcome = await step.run('purge', () => purgeStorefrontProductsNow(storeId));
    // a lost purge must fail the run (queue retry), not look green
    if (outcome === 'failed') throw new Error(`storefront purge failed for store ${storeId}`);
    return { outcome };
  }
);
