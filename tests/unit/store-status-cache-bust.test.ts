/**
 * Ported from tests/integration/store-status-cache-invalidation.test.ts (adversarial audit P1-7; the Postgres original is deleted).
 * Account status is a NEVER-stale value: suspending a store must bust every public cache that carries `status`
 * (resolve-by-domain, by-slug, by-id), or a suspended store keeps serving the active storefront until the TTL.
 * The store row itself now lives in the StoreDO (covered by the DO/route lanes); what is pinned here is the cache bust the
 * status write ends in, and that StoreService.setStatus (which owns write AND bust) runs it, driven with a stand-in DO write.
 */
import { describe, it, expect, vi } from 'vitest';

const calls = vi.hoisted(() => ({ del: [] as string[], writes: [] as unknown[] }));
vi.mock('../../apps/api/src/lib/repo-factory', async importOriginal => ({
  ...(await importOriginal<typeof import('../../apps/api/src/lib/repo-factory')>()),
  // stand-in for the StoreDO write: a store served by its DO, whose status write returns the updated row
  storeWritesToDo: async () => true,
  storeUpdateOnDo: async (id: string, args: { data: { status: string } }) => {
    calls.writes.push(args.data);
    return { id, slug: 'ssc-slug', domain: 'ssc.example.test', status: args.data.status };
  },
}));
vi.mock('../../apps/api/src/services/redis.service', () => ({
  redis: {
    isAvailable: () => true,
    get: async () => null,
    set: async () => undefined,
    delete: async (k: string) => void calls.del.push(k),
    deleteByPattern: async () => 0,
    getCacheGenerations: async (names: string[]) => names.map(() => '0'),
    bumpCacheGeneration: async () => undefined,
  },
}));
vi.mock('../../apps/api/src/lib/store-directory', () => ({
  invalidateStoreDirectory: async () => undefined,
}));
vi.mock('../../apps/api/src/lib/revalidate-storefront', () => ({ revalidateStorefront: () => {} }));

const { bustStoreCaches, StoreService } = await import('../../apps/api/src/services/store.service');

describe('store status write busts the public store caches', () => {
  it('the bust clears the resolve (custom domain + <slug>.ebda.app), slug and id keys', async () => {
    calls.del.length = 0;
    await bustStoreCaches('store-1', 'ssc-slug', 'ssc.example.test');
    const joined = calls.del.join('|');
    expect(joined).toContain('public:store:resolve:ssc.example.test');
    expect(joined).toContain('public:store:ssc-slug');
    expect(joined).toContain('public:store:store-1');
    expect(joined).toMatch(/public:store:resolve:ssc-slug\./);
  });

  it('StoreService.setStatus writes the status and then busts the public caches with the store slug + domain', async () => {
    calls.del.length = 0;
    calls.writes.length = 0;
    const store = await StoreService.setStatus('store-1', 'SUSPENDED' as never);
    expect(calls.writes).toEqual([{ status: 'SUSPENDED' }]);
    expect(store.status).toBe('SUSPENDED');
    const joined = calls.del.join('|');
    expect(joined).toContain('public:store:resolve:ssc.example.test');
    expect(joined).toContain('public:store:ssc-slug');
    expect(joined).toContain('public:store:store-1');
  });
});
