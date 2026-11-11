/**
 * Ruling RESOLVE-BULLETPROOF-1: a domain / slug CHANGE or REMOVAL must stop the OLD address resolving at once.
 * `bustStoreCaches` used to purge only the CURRENT slug/domain on the storefront, so a removed custom domain kept
 * resolving to the store until the API's 120 s resolve TTL and the storefront's own copy expired (domain ownership is
 * NEVER-stale). These assert the old address's storefront tags reach `revalidateStorefront` and its API resolve key is
 * busted.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const calls = vi.hoisted(() => ({ del: [] as string[], purge: [] as unknown[] }));
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
vi.mock('../../apps/api/src/lib/revalidate-storefront', () => ({
  revalidateStorefront: (o: unknown) => void calls.purge.push(o),
}));

const { bustStoreCaches } = await import('../../apps/api/src/services/store.service');

beforeEach(() => {
  calls.del.length = 0;
  calls.purge.length = 0;
});

const tagsOf = () => (calls.purge[0] as { tags: string[] }).tags;

describe('bustStoreCaches purges the PREVIOUS address', () => {
  it('domain removed: the old domain tag is purged (it is no longer the current domain)', async () => {
    await bustStoreCaches('store-1', 'acme', null, { domain: 'WWW.Shop.Example' });
    expect(calls.purge).toHaveLength(1);
    expect(tagsOf()).toContain('store-domain:shop.example');
    expect(tagsOf()).toContain('layout:store-1');
    expect(calls.del.some(k => k.includes('public:store:resolve:WWW.Shop.Example'))).toBe(true);
  });

  it('domain changed: old and new both purged', async () => {
    await bustStoreCaches('store-1', 'acme', 'new.example', { domain: 'old.example' });
    expect(calls.purge[0]).toMatchObject({ slug: 'acme', domain: 'new.example' });
    expect(tagsOf()).toContain('store-domain:old.example');
  });

  it('slug changed: the old slug and its host tag are purged', async () => {
    await bustStoreCaches('store-1', 'new-slug', null, { slug: 'old-slug' });
    expect(tagsOf()).toEqual(
      expect.arrayContaining(['store-slug:old-slug', 'store-domain:old-slug.ebda.app'])
    );
  });

  it('no change: no extra tags', async () => {
    await bustStoreCaches('store-1', 'acme', 'shop.example', {
      slug: 'acme',
      domain: 'shop.example',
    });
    expect(tagsOf()).toEqual(['layout:store-1']);
  });
});
