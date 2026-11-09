/**
 * FIX-001 / FIX-002 regression (audit 2026-10-05, recheck 2026-10-07).
 *
 * FIX-001: a cache fill that read the DB BEFORE a write committed must not
 * republish its pre-write value after that write's invalidation ran.
 * FIX-002: while Redis is healthy, a miss must not be answered from this
 * process's in-memory fallback, which other replicas' invalidations never reach.
 *
 * The Redis mock is a shared in-memory map standing in for one Redis that
 * every replica sees; `vi.resetModules()` gives each test a fresh process.
 * This file covers the Node shell; `public-cache-stale-refill.workers.test.ts`
 * drives the Workers path through the real CfRedis (KV + AuthState DO).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  shared: new Map<string, string>(),
  gens: new Map<string, number>(),
  available: true,
  /** Runs inside `redis.set` before the value lands (to race an invalidation). */
  onSet: null as null | (() => Promise<void>),
}));

vi.mock('../../apps/api/src/services/redis.service', () => ({
  redis: {
    isAvailable: () => h.available,
    get: vi.fn(async (key: string) => (h.available ? (h.shared.get(key) ?? null) : null)),
    set: vi.fn(async (key: string, value: string) => {
      const hook = h.onSet;
      h.onSet = null;
      if (hook) await hook();
      if (h.available) h.shared.set(key, value);
    }),
    delete: vi.fn(async (key: string) => {
      h.shared.delete(key);
    }),
    deleteByPattern: vi.fn(async (prefix: string) => {
      for (const key of [...h.shared.keys()]) if (key.startsWith(prefix)) h.shared.delete(key);
      return 0;
    }),
    getCacheGenerations: vi.fn(async (names: string[]) => {
      if (!h.available) throw new Error('Redis unavailable');
      return names.map(n => (h.gens.has(n) ? String(h.gens.get(n)) : null));
    }),
    bumpCacheGeneration: vi.fn(async (name: string) => {
      if (!h.available) throw new Error('Redis unavailable');
      h.gens.set(name, (h.gens.get(name) ?? 0) + 1);
    }),
  },
}));
vi.mock('../../apps/api/src/lib/db-retry', () => ({
  retryTransientRead: (fn: () => Promise<unknown>) => fn(),
}));
vi.mock('../../apps/api/src/lib/revalidate-storefront', () => ({ revalidateStorefront: vi.fn() }));

beforeEach(() => {
  h.shared.clear();
  h.gens.clear();
  h.available = true;
  h.onSet = null;
  vi.resetModules();
});

/** Start a fill whose DB read is held open until `release` is called. */
async function startHeldFill(
  cache: typeof import('../../apps/api/src/lib/public-cache'),
  key: string
) {
  let release!: (value: { price: number }) => void;
  let announce!: () => void;
  const started = new Promise<void>(r => {
    announce = r;
  });
  const oldRead = new Promise<{ price: number }>(r => {
    release = r;
  });
  const pending = cache.getCached(key, 120, async () => {
    announce();
    return oldRead;
  });
  await started;
  return { release, pending };
}

describe('FIX-001: a pre-write fill cannot republish after invalidation', () => {
  it('prefix invalidation (product price/stock path)', async () => {
    const cache = await import('../../apps/api/src/lib/public-cache');
    const fill = await startHeldFill(cache, 'public:products:audit-store:list');
    // Product update commits here, then invokes the existing invalidator.
    await cache.invalidateCachedPrefix('public:products:audit-store:');
    fill.release({ price: 100 });
    await fill.pending;

    const freshRead = vi.fn(async () => ({ price: 200 }));
    const result = await cache.getCached('public:products:audit-store:list', 120, freshRead);
    expect(result.price).toBe(200);
    expect(freshRead).toHaveBeenCalledTimes(1);
  });

  it('the full order-path invalidator (clearProductsRedis) covers PDP keys', async () => {
    const cache = await import('../../apps/api/src/lib/public-cache');
    const fill = await startHeldFill(cache, 'public:product:audit-store:sku-1');
    await cache.invalidateStoreProductCachesAfterOrder('audit-store');
    fill.release({ price: 100 });
    await fill.pending;
    const result = await cache.getCached('public:product:audit-store:sku-1', 120, async () => ({
      price: 200,
    }));
    expect(result.price).toBe(200);
  });

  it('single-key invalidation (categories / bundles / store keys)', async () => {
    const cache = await import('../../apps/api/src/lib/public-cache');
    const key = cache.bundlesCacheKey('audit-store');
    const fill = await startHeldFill(cache, key);
    await cache.invalidateStoreProductCaches('audit-store');
    fill.release({ price: 100 });
    await fill.pending;
    const result = await cache.getCached(key, 120, async () => ({ price: 200 }));
    expect(result.price).toBe(200);
  });

  it('another replica invalidating mid-fill is seen through the shared generation', async () => {
    const replicaA = await import('../../apps/api/src/lib/public-cache');
    const fill = await startHeldFill(replicaA, 'public:products:audit-store:list');
    vi.resetModules();
    const replicaB = await import('../../apps/api/src/lib/public-cache');
    await replicaB.invalidateCachedPrefix('public:products:audit-store:');
    fill.release({ price: 100 });
    await fill.pending;
    expect(h.shared.has('public:products:audit-store:list')).toBe(false);
  });

  it('an invalidation landing between the generation check and the write is undone', async () => {
    const cache = await import('../../apps/api/src/lib/public-cache');
    // The bump + delete run after the fill's post-fetch check but before its
    // write lands — only the re-check after writing can catch this ordering.
    h.onSet = () => cache.invalidateCachedPrefix('public:products:audit-store:');
    await cache.getCached('public:products:audit-store:list', 120, async () => ({ price: 100 }));
    expect(h.shared.has('public:products:audit-store:list')).toBe(false);
  });

  it('a request arriving after the invalidation does not join the pre-write fetch', async () => {
    const cache = await import('../../apps/api/src/lib/public-cache');
    const fill = await startHeldFill(cache, 'public:products:audit-store:list');
    await cache.invalidateCachedPrefix('public:products:audit-store:');
    const after = cache.getCached('public:products:audit-store:list', 120, async () => ({
      price: 200,
    }));
    fill.release({ price: 100 });
    expect((await after).price).toBe(200);
    expect((await fill.pending).price).toBe(100);
  });

  it('an unrelated store write does not suppress the fill', async () => {
    const cache = await import('../../apps/api/src/lib/public-cache');
    const fill = await startHeldFill(cache, 'public:products:store-a:list');
    await cache.invalidateCachedPrefix('public:products:store-b:');
    fill.release({ price: 100 });
    await fill.pending;
    expect(JSON.parse(h.shared.get('public:products:store-a:list') ?? 'null')).toEqual({
      price: 100,
    });
  });

  it('prefix generation names cover every key the prefix busts', async () => {
    const cache = await import('../../apps/api/src/lib/public-cache');
    for (const [prefix, key] of [
      ['public:products:s1:', 'public:products:s1:1:20::a:b:c:d'],
      ['public:products:s1', 'public:products:s1:feed:v2'],
      ['a:b:c:d:e:', 'a:b:c:d:e:f'],
      ['', 'anything'],
    ] as const) {
      expect(key.startsWith(prefix)).toBe(true);
      expect(cache.generationNamesFor(key)).toContain(cache.generationNameForPrefix(prefix));
    }
  });
});

describe('FIX-002: memory fallback is only consulted while Redis is down', () => {
  it('a healthy Redis miss after another replica invalidates does not serve old local memory', async () => {
    const cache = await import('../../apps/api/src/lib/public-cache');
    await cache.getCached('public:product:audit-store:item', 120, async () => ({ price: 100 }));
    // Another replica commits an update and deletes the shared Redis entry.
    // This process has no notification and retains any local state.
    h.shared.clear();
    const result = await cache.getCached('public:product:audit-store:item', 120, async () => ({
      price: 200,
    }));
    expect(result.price).toBe(200);
  });

  it('an entry cached in memory during an outage is not served once Redis is back', async () => {
    h.available = false;
    const cache = await import('../../apps/api/src/lib/public-cache');
    await cache.getCached('public:product:audit-store:item', 120, async () => ({ price: 100 }));
    // Redis recovers; another replica's write was invalidated there, which
    // this process's memory never hears about.
    h.available = true;
    const result = await cache.getCached('public:product:audit-store:item', 120, async () => ({
      price: 200,
    }));
    expect(result.price).toBe(200);
  });

  it('with Redis down, memory still serves as the fallback', async () => {
    h.available = false;
    const cache = await import('../../apps/api/src/lib/public-cache');
    await cache.getCached('public:store:s1', 120, async () => ({ v: 1 }));
    const second = vi.fn(async () => ({ v: 2 }));
    expect(await cache.getCached('public:store:s1', 120, second)).toEqual({ v: 1 });
    expect(second).not.toHaveBeenCalled();
  });

  it('with Redis down, a local invalidation mid-fill keeps the old value out of memory', async () => {
    h.available = false;
    const cache = await import('../../apps/api/src/lib/public-cache');
    const fill = await startHeldFill(cache, 'public:products:audit-store:list');
    await cache.invalidateCachedPrefix('public:products:audit-store:');
    fill.release({ price: 100 });
    await fill.pending;
    const result = await cache.getCached('public:products:audit-store:list', 120, async () => ({
      price: 200,
    }));
    expect(result.price).toBe(200);
  });
});
