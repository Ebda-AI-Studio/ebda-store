/**
 * Issue 2351 follow-up: the flatten script's storefront tag list stays in step with what
 * `invalidateStoreProductCaches` actually purges. Behaviour, not source text: run the real
 * invalidator against a fake Redis and a spy on `revalidateStorefront`, and compare the tags
 * it sends with `cachePurgeList`. (Replaces a text window over public-cache.ts that matched
 * the first backtick tags after the function name, comments included.)
 */
import { describe, it, expect, vi } from 'vitest';

const revalidate = vi.hoisted(() => vi.fn());
vi.mock('@ebda/database', () => ({ prisma: {}, withMoneyTx: vi.fn() }));
vi.mock('../../apps/api/src/services/redis.service', () => ({
  redis: {
    isAvailable: () => true,
    get: async () => null,
    set: async () => undefined,
    delete: async () => undefined,
    deleteByPattern: async () => 0,
    getCacheGenerations: async (names: string[]) => names.map(() => '0'),
    bumpCacheGeneration: async () => undefined,
  },
}));
vi.mock('../../apps/api/src/lib/revalidate-storefront', () => ({
  revalidateStorefront: revalidate,
}));

import { cachePurgeList } from '../../scripts/flatten-single-variant-products-2026-09-30';
import { invalidateStoreProductCaches } from '../../apps/api/src/lib/public-cache';

describe('flatten script tag list vs invalidateStoreProductCaches', () => {
  it('the tags the real invalidator purges equal the flatten script purge list', async () => {
    await invalidateStoreProductCaches('store-1');
    expect(revalidate).toHaveBeenCalledTimes(1);
    expect(revalidate.mock.calls[0][0].tags).toEqual(cachePurgeList('store-1').tags);
  });
});
