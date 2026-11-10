// Ruling PUBLIC-READ-LIMIT-1: anonymous public reads use the in-colo native limiter; everything
// else keeps the exact Durable Object limiters; a burst still gets a 429; failures fall back.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { setCfBindings, clearCfBindings } from '../../apps/api/src/cf/bindings';

// The real middleware skips everything under vitest (as the DO limiters do); lift that for the test.
vi.mock('../../apps/api/src/middleware/public-limiter-keys', () => ({
  publicIpKey: (r: any) => `ip:${r.ip ?? 'noip'}`,
  publicTenantKey: (r: any) => `t:${r.headers['x-store-domain'] ?? r.ip}`,
  skipPublicLimiters: () => false,
}));
vi.mock('../../apps/api/src/utils/store-helpers', () => ({
  resolvePublicStoreId: async (r: any) => r.__resolved,
}));
import {
  publicReadLimit,
  isAnonymousPublicRead,
  skipsRequestTransaction,
} from '../../apps/api/src/middleware/public-read-limit';

function counter(limit: number) {
  const seen = new Map<string, number>();
  return {
    limit: async ({ key }: { key: string }) => {
      const n = (seen.get(key) ?? 0) + 1;
      seen.set(key, n);
      return { success: n <= limit };
    },
  };
}
function mkRes() {
  const r: any = { code: 200, headers: {} as Record<string, string>, body: undefined };
  r.setHeader = (k: string, v: string) => (r.headers[k] = v);
  r.status = (c: number) => ((r.code = c), r);
  r.json = (b: unknown) => ((r.body = b), r);
  return r;
}
const call = (mw: any, req: any) =>
  new Promise<{ next: boolean; res: any }>(resolve => {
    const res = mkRes();
    const done = (n: boolean) => setTimeout(() => resolve({ next: n, res }), 5);
    const orig = res.json;
    res.json = (b: unknown) => (orig(b), done(false), res);
    mw(req, res, () => done(true));
  });
const get = (extra: Record<string, unknown> = {}) => ({
  method: 'GET',
  path: '/categories',
  query: {},
  __resolved: 'store-1',
  ip: '1.1.1.1',
  headers: { 'x-store-domain': 'a.ebda.app' },
  ...extra,
});

beforeEach(() => clearCfBindings());
afterEach(() => clearCfBindings());

describe('who counts as an anonymous public read', () => {
  const ok = { path: '/categories', query: {} };
  it.each([
    [{ method: 'GET', headers: {}, ...ok }, true],
    [{ method: 'HEAD', headers: {}, ...ok }, true],
    [{ method: 'POST', headers: {}, ...ok }, false],
    [{ method: 'PUT', headers: {}, ...ok }, false],
    [{ method: 'DELETE', headers: {}, ...ok }, false],
    [{ method: 'GET', headers: { authorization: 'Bearer x' }, ...ok }, false],
    [{ method: 'GET', headers: { cookie: 'token=abc' }, ...ok }, false],
    [{ method: 'GET', headers: { cookie: 'anything=1' }, ...ok }, false],
  ])('%j -> %s', (req, want) => {
    expect(isAnonymousPublicRead(req as any)).toBe(want);
  });
});

describe('explicit allowlist: only KV-cached catalogue reads take the native path', () => {
  const H = { 'x-store-domain': 'a.ebda.app' };
  it.each([
    ['/categories', {}],
    ['/tags', {}],
    ['/products', {}],
    ['/products', { page: '2', limit: '24', sort: 'price' }],
    ['/products/linen-abaya', {}],
    ['/size-charts', {}],
    ['/redirects/resolve', { type: 'product', slug: 'old-slug' }],
  ])('%s %j is on the allowlist', (path, query) => {
    expect(isAnonymousPublicRead({ method: 'GET', headers: H, path, query } as any)).toBe(true);
  });
  it.each([
    ['/products', { search: 'abaya' }],
    ['/products', { q: 'abaya' }],
    ['/products', { category: 'abayas' }],
    ['/products', { tag: 'oily' }],
    ['/products', { minPrice: '1' }],
    ['/products', { ids: 'a,b' }],
    ['/products', { page: ['1', '2'] }],
    ['/products', { 'page[$ne]': '1' }],
    ['/tags', { name: 'oily' }],
    ['/categories', { x: '1' }],
    ['/feed/products.json', {}],
    ['/wishlist', {}],
    ['/orders', {}],
    ['/orders/track', {}],
    ['/store/resolve', {}],
    ['/stores/some-slug', {}],
    ['/abc/search/suggest', { q: 'ab' }],
    ['/search', {}],
    ['/reviews/can-submit', {}],
    ['/products/a/b', {}],
    ['/products/..%2Fx', {}],
    ['/anything-else', {}],
    ['/', {}],
  ])('%s %j is NOT on the allowlist (keeps the exact DO limiters)', (path, query) => {
    expect(isAnonymousPublicRead({ method: 'GET', headers: H, path, query } as any)).toBe(false);
  });
  it('an X-Search-Query header on an allowlisted path still disqualifies it', () => {
    expect(
      isAnonymousPublicRead({
        method: 'GET',
        headers: { 'x-search-query': 'a' },
        path: '/products',
        query: {},
      } as any)
    ).toBe(false);
  });
  it('a route not on the allowlist always goes to the exact limiters, native never consulted', async () => {
    const native = { limit: vi.fn(async () => ({ success: true })) };
    setCfBindings({ PUBLIC_IP_LIMITER: native, PUBLIC_TENANT_LIMITER: native } as any);
    for (const path of [
      '/feed/products.json',
      '/wishlist',
      '/orders',
      '/store/resolve',
      '/x/search/suggest',
    ]) {
      const exact = vi.fn((_q: any, _r: any, n: any) => n());
      await call(publicReadLimit(exact as any), get({ path }));
      expect(exact).toHaveBeenCalledTimes(1);
    }
    expect(native.limit).not.toHaveBeenCalled();
  });
});

describe('the tenant bucket is the RESOLVED store, never a raw header', () => {
  it('rotating fake x-store-domain values does not buy a fresh tenant bucket', async () => {
    setCfBindings({ PUBLIC_IP_LIMITER: counter(1000), PUBLIC_TENANT_LIMITER: counter(2) } as any);
    const mw = publicReadLimit(((_q: any, _r: any, n: any) => n()) as any);
    const codes = [];
    for (let i = 0; i < 4; i++)
      codes.push(
        (
          await call(
            mw,
            get({ ip: `5.5.5.${i}`, headers: { 'x-store-domain': `fake-${i}.ebda.app` } })
          )
        ).res.code
      );
    expect(codes).toEqual([200, 200, 429, 429]);
  });
  it('different resolved stores have separate buckets', async () => {
    setCfBindings({ PUBLIC_IP_LIMITER: counter(1000), PUBLIC_TENANT_LIMITER: counter(1) } as any);
    const mw = publicReadLimit(((_q: any, _r: any, n: any) => n()) as any);
    expect((await call(mw, get({ __resolved: 's1' }))).res.code).toBe(200);
    expect((await call(mw, get({ __resolved: 's2' }))).res.code).toBe(200);
    expect((await call(mw, get({ __resolved: 's1' }))).res.code).toBe(429);
  });
  it('an unresolved store goes to the exact limiters, native never consulted', async () => {
    const native = { limit: vi.fn(async () => ({ success: true })) };
    setCfBindings({ PUBLIC_IP_LIMITER: native, PUBLIC_TENANT_LIMITER: native } as any);
    const exact = vi.fn((_q: any, _r: any, n: any) => n());
    await call(publicReadLimit(exact as any), get({ __resolved: undefined }));
    expect(exact).toHaveBeenCalledTimes(1);
    expect(native.limit).not.toHaveBeenCalled();
  });
  it('the exact tenant limiter key also prefers the resolved id', async () => {
    const { publicTenantKey } = await vi.importActual<any>(
      '../../apps/api/src/middleware/public-limiter-keys'
    );
    const { setResolvedStoreId } = await import('../../apps/api/src/utils/resolved-store');
    const req: any = {
      headers: { 'x-store-domain': 'attacker-rotated.ebda.app' },
      ip: '1.1.1.1',
      params: {},
    };
    expect(publicTenantKey(req)).toBe('t:attacker-rotated.ebda.app');
    setResolvedStoreId(req, 'real-id');
    expect(publicTenantKey(req)).toBe('t:real-id');
  });
});

describe('publicReadLimit', () => {
  it('a burst still gets a 429 (per-IP 300/min numbers, scaled down here)', async () => {
    setCfBindings({ PUBLIC_IP_LIMITER: counter(3), PUBLIC_TENANT_LIMITER: counter(1000) } as any);
    const exact = vi.fn((_q: any, _r: any, n: any) => n());
    const mw = publicReadLimit(exact as any);
    const out = [];
    for (let i = 0; i < 5; i++) out.push(await call(mw, get()));
    expect(out.map(o => o.next)).toEqual([true, true, true, false, false]);
    expect(out[3].res.code).toBe(429);
    expect(out[3].res.body.error.code).toBe('RATE_LIMITED');
    expect(out[3].res.headers['Retry-After']).toBe('60');
    expect(exact).not.toHaveBeenCalled();
  });
  it('no client address (a storefront render with no shopper, RL-SSR-IP-6) is never pooled in a per-IP bucket', async () => {
    const ipLimiter = counter(1);
    const keys: string[] = [];
    setCfBindings({
      PUBLIC_IP_LIMITER: {
        limit: async (o: { key: string }) => (keys.push(o.key), ipLimiter.limit(o)),
      },
      PUBLIC_TENANT_LIMITER: counter(1000),
    } as any);
    const mw = publicReadLimit(((_q: any, _r: any, n: any) => n()) as any);
    const out = [];
    for (let i = 0; i < 3; i++) out.push(await call(mw, get({ ip: undefined })));
    expect(out.map(o => o.next)).toEqual([true, true, true]);
    expect(keys).toEqual([]);
  });
  it('the per-tenant limit blocks independently of the IP limit', async () => {
    setCfBindings({ PUBLIC_IP_LIMITER: counter(1000), PUBLIC_TENANT_LIMITER: counter(2) } as any);
    const mw = publicReadLimit(((_q: any, _r: any, n: any) => n()) as any);
    const r = [];
    for (let i = 0; i < 3; i++) r.push((await call(mw, get({ ip: `9.9.9.${i}` }))).res.code);
    expect(r).toEqual([200, 200, 429]);
  });
  it.each([
    [
      'an authenticated request',
      get({ headers: { authorization: 'Bearer x', 'x-store-domain': 'a' } }),
    ],
    ['a cookie-bearing request', get({ headers: { cookie: 'token=a', 'x-store-domain': 'a' } })],
    ['a write', get({ method: 'POST' })],
  ])('%s keeps the exact Durable Object limiters (native never consulted)', async (_n, req) => {
    const native = { limit: vi.fn(async () => ({ success: true })) };
    setCfBindings({ PUBLIC_IP_LIMITER: native, PUBLIC_TENANT_LIMITER: native } as any);
    const exact = vi.fn((_q: any, _r: any, n: any) => n());
    await call(publicReadLimit(exact as any), req);
    expect(exact).toHaveBeenCalledTimes(1);
    expect(native.limit).not.toHaveBeenCalled();
  });
  it('missing bindings, or a binding that throws, fall back to the exact limiters (never to no limit)', async () => {
    const exact = vi.fn((_q: any, _r: any, n: any) => n());
    await call(publicReadLimit(exact as any), get());
    expect(exact).toHaveBeenCalledTimes(1);
    const boom = {
      limit: async () => {
        throw new Error('binding down');
      },
    };
    setCfBindings({ PUBLIC_IP_LIMITER: boom, PUBLIC_TENANT_LIMITER: boom } as any);
    await call(publicReadLimit(exact as any), get());
    expect(exact).toHaveBeenCalledTimes(2);
  });
});

describe('search requests never use the native limiter', () => {
  it.each([
    [
      'X-Search-Query header',
      { headers: { 'x-search-query': 'abaya', 'x-store-domain': 'a' }, path: '/products' },
    ],
    ['legacy ?search', { query: { search: 'abaya' }, path: '/products' }],
    ['?q', { query: { q: 'abaya' }, path: '/products' }],
    ['typeahead path', { path: '/abc/search/suggest' }],
    ['search path', { path: '/search' }],
  ])('a cookie-less anonymous %s goes through the exact DO limiter', async (_n, extra) => {
    const native = { limit: vi.fn(async () => ({ success: true })) };
    setCfBindings({ PUBLIC_IP_LIMITER: native, PUBLIC_TENANT_LIMITER: native } as any);
    const exact = vi.fn((_q: any, _r: any, n: any) => n());
    await call(publicReadLimit(exact as any), get(extra as any));
    expect(exact).toHaveBeenCalledTimes(1);
    expect(native.limit).not.toHaveBeenCalled();
  });
});

describe('wiring', () => {
  it('the public router mounts the native gate in front of BOTH exact limiters', () => {
    const src = readFileSync(join(__dirname, '../../apps/api/src/routes/public.routes.ts'), 'utf8');
    expect(src).toContain(
      'router.use(publicReadLimit(inParallel(publicLimiter, publicTenantLimiter)));'
    );
  });
  it('the native limits are at least the exact limiters numbers (300 / 6000 per minute)', () => {
    const cfg = readFileSync(join(__dirname, '../../apps/api/wrangler.jsonc'), 'utf8');
    expect(cfg).toMatch(/"PUBLIC_IP_LIMITER"[^}]*"limit": 300, "period": 60/);
    expect(cfg).toMatch(/"PUBLIC_TENANT_LIMITER"[^}]*"limit": 6000, "period": 60/);
    const sec = readFileSync(join(__dirname, '../../apps/api/src/middleware/security.ts'), 'utf8');
    expect(sec).toMatch(/max: 300,/);
    expect(sec).toMatch(/PUBLIC_TENANT_RATE_LIMIT_PER_MIN\) \|\| 6000/);
  });
});

describe('skipsRequestTransaction (Ruling LAZY-TX-1): exactly /categories and /tags, anonymous, no query', () => {
  const base = { method: 'GET', headers: {}, query: {} };
  it.each([
    [{ ...base, path: '/categories' }, true],
    [{ ...base, path: '/categories/' }, true],
    [{ ...base, path: '/tags' }, true],
    [{ ...base, method: 'HEAD', path: '/tags' }, true],
    [{ ...base, path: '/products' }, true],
    [{ ...base, path: '/products', query: { page: '2', limit: '24', sort: 'price' } }, true],
    [{ ...base, path: '/products/linen-abaya' }, true],
    [{ ...base, path: '/products', query: { search: 'a' } }, false],
    [{ ...base, path: '/products', query: { q: 'a' } }, false],
    [{ ...base, path: '/products', query: { category: 'x' } }, false],
    [{ ...base, path: '/products', query: { tag: 'x' } }, false],
    [{ ...base, path: '/products', query: { ids: 'a,b' } }, false],
    [{ ...base, path: '/products', query: { minPrice: '1' } }, false],
    [{ ...base, path: '/products', query: { opt_color: 'red' } }, false],
    [{ ...base, path: '/products', query: { page: ['1', '2'] } }, false],
    [{ ...base, path: '/products/x', query: { x: '1' } }, false],
    [{ ...base, path: '/products/a/b' }, false],
    [{ ...base, path: '/products', headers: { cookie: 'a=b' } }, false],
    [{ ...base, path: '/products/x', headers: { authorization: 'Bearer x' } }, false],
    [{ ...base, path: '/categories/x' }, false],
    [{ ...base, path: '/categories', query: { x: '1' } }, false],
    [{ ...base, path: '/tags', query: { name: 'oily' } }, false],
    [{ ...base, path: '/categories', headers: { authorization: 'Bearer x' } }, false],
    [{ ...base, path: '/categories', headers: { cookie: 'a=b' } }, false],
    [{ ...base, path: '/categories', headers: { 'x-search-query': 'a' } }, false],
    [{ ...base, method: 'POST', path: '/categories' }, false],
    [{ ...base, path: '/size-charts' }, false],
    [{ ...base, path: '/store/resolve' }, false],
  ])('%j -> %s', (req, want) => {
    expect(skipsRequestTransaction(req as any)).toBe(want);
  });
});
