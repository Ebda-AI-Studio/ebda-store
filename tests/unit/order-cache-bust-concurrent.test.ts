/**
 * Ruling PERF-LAT-2: the post-order product-cache bust runs its invalidations together, not one after another.
 *
 * The redis mock counts SERIAL round trips the way `lib/io-tally.ts` (PERF-LAT-1) does: a call that starts while no other
 * call is in flight opens a new wave. Before: 8 invalidations x (generation bump, then delete) = 16 waves, plus the KV scan
 * of each prefix. After: one bump wave and one delete wave.
 * Also pinned: every key and prefix is still cleared, the generation is still bumped BEFORE its delete, and one failing
 * invalidation neither stops the others nor goes unreported (the order path logs it exactly as before).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const io = vi.hoisted(() => ({
  waves: 0,
  inflight: 0,
  log: [] as string[],
  failBump: '' as string,
}));
const call = async (label: string, fail = false) => {
  if (io.inflight === 0) io.waves++;
  io.inflight++;
  io.log.push(label);
  await new Promise(r => setTimeout(r, 1));
  io.inflight--;
  if (fail) throw new Error(`boom ${label}`);
};
vi.mock('../../apps/api/src/services/redis.service', () => ({
  redis: {
    isAvailable: () => true,
    get: async () => null,
    set: async () => undefined,
    delete: (k: string) => call(`del:${k}`),
    deleteByPattern: async (p: string) => {
      await call(`delp:${p}`);
      return 0;
    },
    getCacheGenerations: async (names: string[]) => names.map(() => '0'),
    bumpCacheGeneration: (n: string) =>
      call(`bump:${n}`, io.failBump !== '' && n.includes(io.failBump)),
  },
}));
vi.mock('../../apps/api/src/lib/revalidate-storefront', () => ({ revalidateStorefront: () => {} }));

const cache = await import('../../apps/api/src/lib/public-cache');
const S = 'store-1';

beforeEach(() => {
  io.waves = 0;
  io.inflight = 0;
  io.log = [];
  io.failBump = '';
});

const EXPECTED_DELETES = [
  `delp:public:products:${S}:`,
  `delp:public:product:${S}:`,
  `delp:public:suggest:${S}:`,
  `delp:recommendations:product:${S}:`,
  `delp:admin:products:${S}:`,
  `del:public:categories:${S}`,
  `del:admin:categories:${S}`,
  `del:${cache.bundlesCacheKey(S)}`,
];

describe('post-order cache bust (PERF-LAT-2)', () => {
  it('clears every layer and key in 2 serial waves (was 16)', async () => {
    await cache.invalidateStoreProductCachesAfterOrder(S);
    expect(io.log.filter(l => l.startsWith('del')).sort()).toEqual([...EXPECTED_DELETES].sort());
    expect(io.log.filter(l => l.startsWith('bump:'))).toHaveLength(8);
    expect(io.waves).toBeLessThanOrEqual(2);
  });
  it('the content-edit bust (invalidateStoreProductCaches) gets the same', async () => {
    await cache.invalidateStoreProductCaches(S);
    expect(io.log.filter(l => l.startsWith('del')).sort()).toEqual([...EXPECTED_DELETES].sort());
    expect(io.waves).toBeLessThanOrEqual(2);
  });
  it('each generation is still bumped before its own delete', async () => {
    await cache.invalidateStoreProductCachesAfterOrder(S);
    const firstDelete = io.log.findIndex(l => l.startsWith('del'));
    expect(io.log.slice(0, firstDelete).every(l => l.startsWith('bump:'))).toBe(true);
    expect(firstDelete).toBe(8);
  });
  it('a failed generation bump still deletes every key (unchanged: bumpGeneration swallows it)', async () => {
    io.failBump = 'admin:categories';
    await cache.invalidateStoreProductCachesAfterOrder(S);
    expect(io.log.filter(l => l.startsWith('del')).sort()).toEqual([...EXPECTED_DELETES].sort());
  });
  it('an invalidation that throws does not stop the others, and its error reaches the caller', async () => {
    const done: string[] = [];
    const ok = (n: string) => new Promise<void>(r => setTimeout(() => (done.push(n), r()), 2));
    const bad = Promise.reject(new Error('kv down'));
    await expect(cache.allInvalidations([ok('a'), bad, ok('b')])).rejects.toThrow('kv down');
    expect(done.sort()).toEqual(['a', 'b']);
  });
  it('the order path still logs a failed bust and never fails the order', async () => {
    const src = (await import('node:fs')).readFileSync(
      (await import('node:path')).resolve(
        __dirname,
        '../../apps/api/src/services/order.service.ts'
      ),
      'utf8'
    );
    expect(src).toMatch(
      /async function bustProductCaches[\s\S]{0,300}try \{[\s\S]{0,200}invalidateStoreProductCachesAfterOrder\(storeId\)[\s\S]{0,120}catch \(err\)[\s\S]{0,80}logger\.warn/
    );
  });
});
