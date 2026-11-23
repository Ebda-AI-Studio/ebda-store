/**
 * Ported from tests/integration/store-status-cache-invalidation.test.ts (adversarial audit P1-7; the Postgres original is deleted).
 * Account status is a NEVER-stale value: suspending a store must bust every public cache that carries `status`
 * (resolve-by-domain, by-slug, by-id), or a suspended store keeps serving the active storefront until the TTL.
 * The store row itself now lives in the StoreDO (covered by the DO/route lanes); what is pinned here is the cache bust the
 * status write ends in, and that the status PATCH goes through StoreService.setStatus (which owns write AND bust).
 */
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const calls = vi.hoisted(() => ({ del: [] as string[] }));
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

const { bustStoreCaches } = await import('../../apps/api/src/services/store.service');
const read = (p: string) => readFileSync(path.resolve(__dirname, '../../apps/api/src', p), 'utf8');

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

  it('PATCH /:id/status goes through StoreService.setStatus, and setStatus ends in bustStoreCaches with slug + domain', () => {
    const route = read('routes/store.routes.ts');
    const at = route.indexOf("'/:id/status'");
    expect(at).toBeGreaterThan(-1);
    expect(route.slice(at, at + 4000)).toMatch(/StoreService\.setStatus\(/);
    const svc = read('services/store.service.ts');
    const s = svc.indexOf('static async setStatus');
    expect(svc.slice(s, s + 600)).toMatch(
      /bustStoreCaches\(store\.id, store\.slug, store\.domain\)/
    );
  });
});
