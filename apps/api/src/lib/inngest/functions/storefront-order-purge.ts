import type { JobDef } from '../../jobs/types';
import { purgeStorefrontProductsNow } from '../../public-cache';
import { inngest } from '../client';

/** Event sent by `invalidateStoreProductCachesAfterOrder` on EVERY order (#663). */
// pq-allow(unused-export): imported by tests and kept public for senders
export const ORDER_PURGE_EVENT = 'storefront/order-purge-requested';

/**
 * Durable trailing purge of a store's storefront product/category/bundle caches after orders (#663).
 *
 * The in-request purge is leading-edge and the in-isolate coalescing window is best-effort (a Worker may drop its
 * timer; `waitUntil` lives 30 s and is tied to the request that registered it). This job is the guarantee: a
 * per-store DEBOUNCED queue message, so it runs once, 10 s after the LAST order of a burst, in its own queue
 * invocation with its own retry budget, whatever happened to the requests that placed the orders.
 *
 * STALENESS CLASS: inventory is NEVER-stale; residual window = 10 s debounce + purge retries (<= ~17 s).
 */
export const storefrontOrderPurge: JobDef = inngest.createFunction(
  {
    id: 'storefront-order-purge',
    name: 'Storefront: trailing product-cache purge after orders',
    retries: 1,
    debounce: { key: 'event.data.storeId', period: '10s', timeout: '1m' },
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
