/**
 * SEO-3 / P14 (Ruling EDGE-API-1): the Worker's public edge cache serves price and stock only while the cache
 * generations are unchanged, so a write followed by a read always sees fresh data, in every data centre.
 *
 * The Redis mock stands in for the strongly consistent AuthState DO (generations); the Cache API is an in-memory map.
 * The "origin" drives the real `captureEdgeSnapshot` + `setEdgeCache`, and writes go through the real
 * `invalidateStoreProductCaches` / `invalidateCached`, so the test breaks if a write path stops bumping a
 * generation the edge layer depends on.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const h = vi.hoisted(() => ({ gens: new Map<string, number>(), available: true }));

vi.mock('../../apps/api/src/services/redis.service', () => ({
  redis: {
    isAvailable: () => h.available,
    get: vi.fn(async () => null),
    set: vi.fn(async () => undefined),
    delete: vi.fn(async () => undefined),
    deleteByPattern: vi.fn(async () => 0),
    getCacheGenerations: vi.fn(async (names: string[]) => {
      if (!h.available) throw new Error('Redis unavailable');
      return names.map(n => (h.gens.has(n) ? String(h.gens.get(n)) : null));
    }),
    bumpCacheGeneration: vi.fn(async (name: string) => {
      h.gens.set(name, (h.gens.get(name) ?? 0) + 1);
    }),
  },
}));
vi.mock('../../apps/api/src/lib/revalidate-storefront', () => ({ revalidateStorefront: vi.fn() }));

import {
  servePublicEdge,
  publicEdgeKey,
  type CacheLike,
  type EdgeDeps,
} from '../../apps/api/src/cf/public-edge-cache';
import { captureEdgeSnapshot, readEdgeGens } from '../../apps/api/src/lib/edge-gens';
import { setEdgeCache } from '../../apps/api/src/lib/edge-cache';
import {
  invalidateCached,
  invalidateStoreProductCaches,
  invalidateStoreProductCachesAfterOrder,
} from '../../apps/api/src/lib/public-cache';

const STORE_A = '11111111-1111-4111-8111-111111111111';
const STORE_B = '22222222-2222-4222-8222-222222222222';
const HOST_A = 'shop-a.ebda.app';
const HOST_B = 'shop-b.ebda.app';
const URL_LIST = 'https://api.ebda.app/api/v1/public/products?limit=20';
const URL_PDP = 'https://api.ebda.app/api/v1/public/products/abaya';

class MapCache implements CacheLike {
  readonly m = new Map<string, Response>();
  async match(key: Request | string) {
    return this.m.get(String(key))?.clone();
  }
  async put(key: Request | string, res: Response) {
    this.m.set(String(key), res);
  }
}

let clock = 1_000_000;
let cache: MapCache;
let db: Record<string, { price: number }>; // storeId -> row the origin reads
let originCalls: number;
let seenFillMarker: Array<string | null>;
let beforeOriginReturns: (() => Promise<void>) | null;
const waits: Promise<unknown>[] = [];

const deps = (): EdgeDeps => ({ cache, readGens: readEdgeGens, now: () => clock });
const ctx = { waitUntil: (p: Promise<unknown>) => void waits.push(p) };

/** An Express stand-in that runs the real snapshot + header code. */
function origin(opts: { storeId?: string; neverStale?: boolean; cc?: string } = {}) {
  return async (request: Request): Promise<Response> => {
    originCalls++;
    seenFillMarker.push(request.headers.get('x-ebda-edge-fill'));
    const storeId = opts.storeId ?? STORE_A;
    const headers: Record<string, string | undefined> = {};
    for (const [k, v] of request.headers) headers[k] = v;
    const req = { headers } as never;
    await captureEdgeSnapshot(req, storeId);
    const row = db[storeId]; // the data read happens AFTER the snapshot
    if (beforeOriginReturns) {
      const f = beforeOriginReturns;
      beforeOriginReturns = null;
      await f();
    }
    const out: Record<string, string> = {};
    const res = {
      req,
      setHeader: (k: string, v: string) => void (out[k.toLowerCase()] = v),
      vary: (v: string) => void (out.vary = out.vary ? `${out.vary}, ${v}` : v),
    } as never;
    setEdgeCache(res, {
      sMaxAge: 60,
      staleWhileRevalidate: 300,
      neverStale: opts.neverStale ?? true,
    });
    if (opts.cc) out['cache-control'] = opts.cc;
    return new Response(JSON.stringify({ price: row.price }), {
      status: 200,
      headers: { 'content-type': 'application/json', ...out },
    });
  };
}

function get(url = URL_LIST, host = HOST_A, extra: Record<string, string> = {}) {
  return new Request(url, { headers: { 'x-store-domain': host, ...extra } });
}
async function read(o: ReturnType<typeof origin>, url = URL_LIST, host = HOST_A, extra = {}) {
  const res = await servePublicEdge(get(url, host, extra), ctx, o, deps());
  await Promise.all(waits.splice(0));
  return {
    state: res.headers.get('x-edge-cache'),
    body: (await res.json()) as { price: number },
    res,
  };
}

beforeEach(() => {
  h.gens.clear();
  h.available = true;
  clock = 1_000_000;
  cache = new MapCache();
  db = { [STORE_A]: { price: 100 }, [STORE_B]: { price: 7 } };
  originCalls = 0;
  seenFillMarker = [];
  beforeOriginReturns = null;
  waits.length = 0;
});

describe('hit path', () => {
  it('second identical read is a HIT and never reaches the origin', async () => {
    const o = origin();
    expect((await read(o)).state).toBe('MISS');
    const second = await read(o);
    expect(second.state).toBe('HIT');
    expect(second.body.price).toBe(100);
    expect(originCalls).toBe(1);
  });
  it('strips every internal header from what the client sees and restores the route Cache-Control', async () => {
    const o = origin();
    await read(o);
    const { res } = await read(o);
    expect(res.headers.get('x-ebda-edge-fill')).toBeNull();
    expect(res.headers.get('x-ebda-edge-class')).toBeNull();
    expect(res.headers.get('x-ebda-edge-meta')).toBeNull();
    expect(res.headers.get('cache-control')).toBe(
      'public, s-maxage=60, stale-while-revalidate=300'
    );
    expect(res.headers.get('vary')).toContain('x-store-domain');
    expect([...cache.m.values()][0].headers.get('vary')).toBeNull();
  });
  it('the origin sees the fill marker only on a fill', async () => {
    await read(origin());
    expect(seenFillMarker).toEqual(['1']);
  });
});

describe('write then read sees fresh data (NEVER-stale price/stock)', () => {
  it('a product write (invalidateStoreProductCaches) invalidates the list and the PDP edge copies', async () => {
    const o = origin();
    await read(o, URL_LIST);
    await read(o, URL_PDP);
    expect((await read(o, URL_PDP)).state).toBe('HIT');
    db[STORE_A].price = 80; // admin edits the price, then the service invalidates
    await invalidateStoreProductCaches(STORE_A);
    const list = await read(o, URL_LIST);
    const pdp = await read(o, URL_PDP);
    expect([list.state, pdp.state]).toEqual(['MISS', 'MISS']);
    expect([list.body.price, pdp.body.price]).toEqual([80, 80]);
  });
  it('a checkout stock change (invalidateStoreProductCachesAfterOrder, also the DO order path) invalidates', async () => {
    const o = origin();
    await read(o);
    db[STORE_A].price = 55;
    await invalidateStoreProductCachesAfterOrder(STORE_A);
    expect((await read(o)).body.price).toBe(55);
  });
  it('a store status/domain change (public:store:resolve:<host>) invalidates every catalogue copy of that host', async () => {
    const o = origin();
    await read(o);
    await invalidateCached(`public:store:resolve:${HOST_A}`);
    expect((await read(o)).state).toBe('MISS');
  });
  it('another store write does not evict this store', async () => {
    const o = origin();
    await read(o);
    await invalidateStoreProductCaches(STORE_B);
    expect((await read(o)).state).toBe('HIT');
  });
  it('a write that lands WHILE the origin reads makes the stored copy invalid, never wrongly valid', async () => {
    const o = origin();
    beforeOriginReturns = async () => {
      // commit + invalidate after the snapshot and the (old) read
      await invalidateStoreProductCaches(STORE_A);
    };
    await read(o); // stores the pre-write body under the pre-write generations
    db[STORE_A].price = 9;
    const next = await read(o);
    expect(next.state).toBe('MISS');
    expect(next.body.price).toBe(9);
  });
});

describe('fail closed', () => {
  it('unreadable generations on a hit go to the origin', async () => {
    const o = origin();
    await read(o);
    h.available = false;
    const r = await read(o);
    expect(r.state).not.toBe('HIT');
    expect(originCalls).toBe(2);
  });
  it('unreadable generations at fill time store nothing', async () => {
    h.available = false;
    const o = origin();
    expect((await read(o)).state).toBe('BYPASS');
    h.available = true;
    expect((await read(o)).state).toBe('MISS');
  });
  it('private/no-store, 404 and Set-Cookie answers are never stored', async () => {
    for (const cc of ['private, no-store', 'public, s-maxage=0']) {
      cache = new MapCache();
      const o = origin({ cc });
      await read(o);
      expect(cache.m.size).toBe(0);
    }
    const notFound = async () =>
      new Response('{}', { status: 404, headers: { 'cache-control': 'public, s-maxage=60' } });
    await servePublicEdge(get(), ctx, notFound, deps());
    const cookie = async () =>
      new Response('{}', {
        status: 200,
        headers: { 'cache-control': 'public, s-maxage=60', 'set-cookie': 'a=b' },
      });
    await servePublicEdge(get(), ctx, cookie, deps());
    expect(cache.m.size).toBe(0);
  });
});

describe('windows', () => {
  it('NEVER-stale is not served past the fresh window; BOUNDED-stale is, with a background refresh', async () => {
    const never = origin({ neverStale: true });
    await read(never);
    clock += 61_000;
    expect((await read(never)).state).toBe('MISS');

    cache = new MapCache();
    originCalls = 0;
    const bounded = origin({ neverStale: false });
    await read(bounded, 'https://api.ebda.app/api/v1/public/categories');
    clock += 61_000;
    const stale = await read(bounded, 'https://api.ebda.app/api/v1/public/categories');
    expect(stale.state).toBe('STALE');
    expect(originCalls).toBe(2); // the refresh
    clock += 1_000;
    expect((await read(bounded, 'https://api.ebda.app/api/v1/public/categories')).state).toBe(
      'HIT'
    );
  });
  it('a stale copy whose generations moved is not served', async () => {
    const bounded = origin({ neverStale: false });
    const url = 'https://api.ebda.app/api/v1/public/categories';
    await read(bounded, url);
    clock += 61_000;
    await invalidateCached(`public:categories:${STORE_A}`);
    expect((await read(bounded, url)).state).toBe('MISS');
  });
  it('an entry older than fresh+swr is not served', async () => {
    const o = origin({ neverStale: false });
    await read(o);
    clock += 400_000;
    expect((await read(o)).state).toBe('MISS');
  });
});

describe('tenant isolation and eligibility', () => {
  it('two hosts never share an entry', async () => {
    const a = origin({ storeId: STORE_A });
    const b = origin({ storeId: STORE_B });
    await read(a, URL_LIST, HOST_A);
    const other = await read(b, URL_LIST, HOST_B);
    expect(other.state).toBe('MISS');
    expect(other.body.price).toBe(7);
    expect((await read(a, URL_LIST, HOST_A)).body.price).toBe(100);
  });
  it('different CORS origins and query strings are different keys; query order is not', async () => {
    expect(publicEdgeKey(get(URL_LIST, HOST_A, { origin: 'https://a.example' }))).not.toBe(
      publicEdgeKey(get(URL_LIST, HOST_A, { origin: 'https://b.example' }))
    );
    expect(publicEdgeKey(get('https://api.ebda.app/api/v1/public/products?a=1&b=2'))).toBe(
      publicEdgeKey(get('https://api.ebda.app/api/v1/public/products?b=2&a=1'))
    );
    expect(publicEdgeKey(get('https://api.ebda.app/api/v1/public/products?a=1'))).not.toBe(
      publicEdgeKey(get('https://api.ebda.app/api/v1/public/products?a=2'))
    );
  });
  it.each([
    ['cookie', { cookie: 'token=x' }],
    ['authorization', { authorization: 'Bearer x' }],
    ['x-store-id', { 'x-store-id': STORE_A }],
    ['do backend opt-in', { 'x-ebda-backend': 'do' }],
    ['builder preview', { 'x-builder-preview-token': 't' }],
    ['search header', { 'x-search-query': 'abc' }],
  ])('%s bypasses the layer', async (_n, hdr) => {
    expect(publicEdgeKey(get(URL_LIST, HOST_A, hdr))).toBeNull();
  });
  it('only the four catalogue reads, GET only, with a store host', () => {
    expect(
      publicEdgeKey(
        new Request(URL_LIST, { method: 'POST', headers: { 'x-store-domain': HOST_A } })
      )
    ).toBeNull();
    expect(publicEdgeKey(new Request(URL_LIST))).toBeNull();
    expect(publicEdgeKey(get('https://api.ebda.app/api/v1/public/orders'))).toBeNull();
    expect(publicEdgeKey(get('https://api.ebda.app/api/v1/public/store/resolve'))).toBeNull();
    expect(publicEdgeKey(get('https://api.ebda.app/api/v1/stores/x/products'))).toBeNull();
    for (const p of ['products', 'products/abaya', 'categories', 'tags'])
      expect(publicEdgeKey(get(`https://api.ebda.app/api/v1/public/${p}`))).not.toBeNull();
  });
  it('a client-supplied fill marker never reaches the origin as a fill and is not trusted', async () => {
    const o = origin();
    await servePublicEdge(
      get(URL_LIST, HOST_A, { 'x-ebda-edge-fill': '1', cookie: 'a=b' }),
      ctx,
      o,
      deps()
    );
    expect(seenFillMarker).toEqual([null]);
  });
});

describe('write-path wiring', () => {
  const src = (p: string) => readFileSync(join(__dirname, '../../apps/api/src', p), 'utf8');
  it('price/stock read routes opt in to the NEVER-stale class', () => {
    const routes = src('routes/public.routes.ts');
    // product list + PDP + the advertising catalogue feed (feedHandler, Ruling FEEDS-4: invalidated by the same
    // product-cache write paths, never a TTL-only copy of price/stock).
    expect(routes.match(/neverStale: true/g)?.length).toBe(3);
    expect(routes).toMatch(/doc\.edgeSeconds, staleWhileRevalidate: 0, neverStale: true/);
  });
});
