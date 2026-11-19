// Ruling PERF-AUTHSTATE-1: GET /public/store/resolve limits on the Workers Rate Limiting bindings (no Durable Object round trip),
// keyed by the forwarded shopper address, with the unknown-store miss counted lazily on the 404 path. Anything unusual falls back
// to the exact Durable Object limiters; every other route and every authenticated/cookie request is untouched.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { setCfBindings, clearCfBindings } from '../../apps/api/src/cf/bindings';

vi.mock('../../apps/api/src/middleware/public-limiter-keys', () => ({
  publicIpKey: (r: any) => `ip:${r.ip ?? 'noip'}`,
  publicTenantKey: (r: any) => `t:${r.headers['x-store-domain'] ?? r.ip}`,
  skipPublicLimiters: () => false,
}));
vi.mock('../../apps/api/src/utils/store-helpers', () => ({
  resolvePublicStoreId: async (r: any) => r.__resolved,
}));
import {
  countStoreMiss,
  isAnonymousStoreResolve,
  storeResolveIsNative,
  storeResolveLimit,
  warnMissingStoreResolveBindings,
  resetStoreResolveBindingWarning,
} from '../../apps/api/src/middleware/store-resolve-native';
import { publicReadLimit } from '../../apps/api/src/middleware/public-read-limit';
import { plannedPublicHits } from '../../apps/api/src/middleware/public-limit-prefetch';

function counter(limit: number) {
  const seen = new Map<string, number>();
  const calls: string[] = [];
  return {
    calls,
    limit: async ({ key }: { key: string }) => {
      calls.push(key);
      const n = (seen.get(key) ?? 0) + 1;
      seen.set(key, n);
      return { success: n <= limit };
    },
  };
}
const boom = {
  limit: async () => {
    throw new Error('binding down');
  },
};
function mkRes() {
  const r: any = { code: 200, headers: {} as Record<string, string>, body: undefined, sent: false };
  r.setHeader = (k: string, v: string) => (r.headers[k] = v);
  r.status = (c: number) => ((r.code = c), r);
  r.json = (b: unknown) => ((r.body = b), (r.sent = true), r);
  return r;
}
const run = (mw: any, req: any) =>
  new Promise<{ next: boolean; res: any }>(resolve => {
    const res = mkRes();
    const done = (n: boolean) => setTimeout(() => resolve({ next: n, res }), 5);
    const orig = res.json;
    res.json = (b: unknown) => (orig(b), done(false), res);
    mw(req, res, () => done(true));
  });
const resolveReq = (extra: Record<string, unknown> = {}) => ({
  method: 'GET',
  path: '/store/resolve',
  query: {},
  ip: '203.0.113.7',
  headers: { 'x-store-domain': 'shop.example.com' },
  ...extra,
});
const bindings = (o: Record<string, unknown> = {}) =>
  setCfBindings({
    PUBLIC_IP_LIMITER: counter(1000),
    STORE_RESOLVE_LIMITER: counter(1000),
    STORE_MISS_LIMITER: counter(1000),
    ...o,
  } as any);
const exactSpy = () => {
  const fn: any = vi.fn((_req: any, _res: any, next: () => void) => next());
  return fn;
};

beforeEach(() => clearCfBindings());
afterEach(() => clearCfBindings());

describe('what counts as the native store-resolve request', () => {
  it('only an anonymous GET/HEAD of /store/resolve with no query and no cookie/authorization', () => {
    expect(isAnonymousStoreResolve(resolveReq() as any)).toBe(true);
    expect(isAnonymousStoreResolve(resolveReq({ method: 'HEAD' }) as any)).toBe(true);
    expect(isAnonymousStoreResolve(resolveReq({ method: 'POST' }) as any)).toBe(false);
    expect(isAnonymousStoreResolve(resolveReq({ path: '/stores/abc' }) as any)).toBe(false);
    expect(isAnonymousStoreResolve(resolveReq({ query: { preview: '1' } }) as any)).toBe(false);
    expect(isAnonymousStoreResolve(resolveReq({ headers: { cookie: 'a=b' } }) as any)).toBe(false);
    expect(
      isAnonymousStoreResolve(resolveReq({ headers: { authorization: 'Bearer x' } }) as any)
    ).toBe(false);
  });
  it('is native only when ALL THREE bindings exist', () => {
    expect(storeResolveIsNative(resolveReq() as any)).toBe(false);
    bindings();
    expect(storeResolveIsNative(resolveReq() as any)).toBe(true);
    setCfBindings({ PUBLIC_IP_LIMITER: counter(1), STORE_RESOLVE_LIMITER: counter(1) } as any);
    expect(storeResolveIsNative(resolveReq() as any)).toBe(false);
  });
});

describe('storeResolveLimit (route level, 30/min per shopper IP)', () => {
  it('passes under the limit without touching the exact limiter, keyed by the shopper address', async () => {
    const c = counter(30);
    bindings({ STORE_RESOLVE_LIMITER: c });
    const exact = exactSpy();
    const r = await run(storeResolveLimit(exact), resolveReq());
    expect(r.next).toBe(true);
    expect(exact).not.toHaveBeenCalled();
    expect(c.calls).toEqual(['resolve:203.0.113.7']);
  });
  it('the 31st request from one address gets the 429 body and Retry-After; another address is unaffected', async () => {
    bindings({ STORE_RESOLVE_LIMITER: counter(30) });
    const mw = storeResolveLimit(exactSpy());
    for (let i = 0; i < 30; i++) expect((await run(mw, resolveReq())).next).toBe(true);
    const blocked = await run(mw, resolveReq());
    expect(blocked.next).toBe(false);
    expect(blocked.res.code).toBe(429);
    expect(blocked.res.headers['Retry-After']).toBe('60');
    expect(blocked.res.body.error.code).toBe('RATE_LIMITED');
    expect((await run(mw, resolveReq({ ip: '198.51.100.9' }))).next).toBe(true);
  });
  it('with no client address nothing is counted (same as the exact limiter)', async () => {
    const c = counter(1);
    bindings({ STORE_RESOLVE_LIMITER: c });
    const r = await run(storeResolveLimit(exactSpy()), resolveReq({ ip: undefined }));
    expect(r.next).toBe(true);
    expect(c.calls).toEqual([]);
  });
  it('a throwing binding falls back to the exact limiter, never to no limit', async () => {
    bindings({ STORE_RESOLVE_LIMITER: boom });
    const exact = exactSpy();
    await run(storeResolveLimit(exact), resolveReq());
    expect(exact).toHaveBeenCalledTimes(1);
  });
  it('without the bindings, or for a request that is not the anonymous resolve, the exact limiter runs', async () => {
    const exact = exactSpy();
    await run(storeResolveLimit(exact), resolveReq());
    bindings();
    await run(storeResolveLimit(exact), resolveReq({ headers: { cookie: 'a=b' } }));
    expect(exact).toHaveBeenCalledTimes(2);
  });
});

describe('router-level per-IP bucket for the resolve route', () => {
  it('uses only PUBLIC_IP_LIMITER (no tenant bucket keyed on the host), and blocks over 300', async () => {
    const ip = counter(2);
    const tenant = counter(1000);
    bindings({ PUBLIC_IP_LIMITER: ip, PUBLIC_TENANT_LIMITER: tenant });
    const exact = exactSpy();
    const mw = publicReadLimit(exact);
    expect((await run(mw, resolveReq())).next).toBe(true);
    expect((await run(mw, resolveReq())).next).toBe(true);
    const blocked = await run(mw, resolveReq());
    expect(blocked.res.code).toBe(429);
    expect(tenant.calls).toEqual([]);
    expect(exact).not.toHaveBeenCalled();
  });
  it('a throwing binding falls back to the exact limiters', async () => {
    bindings({ PUBLIC_IP_LIMITER: boom });
    const exact = exactSpy();
    await run(publicReadLimit(exact), resolveReq());
    expect(exact).toHaveBeenCalledTimes(1);
  });
  it('plans NO Durable Object hits or peeks for a native resolve, and still plans them for everything else', () => {
    bindings({ PUBLIC_TENANT_LIMITER: counter(1) });
    expect(plannedPublicHits(resolveReq() as any)).toEqual({ hits: [], peeks: [] });
    const other = plannedPublicHits(resolveReq({ path: '/stores/abc' }) as any);
    expect(other.peeks.length + other.hits.length).toBeGreaterThan(0);
    clearCfBindings();
    const noBinding = plannedPublicHits(resolveReq() as any);
    expect(noBinding.peeks.length).toBeGreaterThan(0);
  });
});

describe('countStoreMiss (lazy, on the 404 path)', () => {
  it('counts one miss per call by shopper IP and lets the first 20 through', async () => {
    const c = counter(20);
    bindings({ STORE_MISS_LIMITER: c });
    for (let i = 0; i < 20; i++)
      expect(await countStoreMiss(resolveReq() as any, mkRes())).toBe(false);
    expect(c.calls).toHaveLength(20);
    expect(new Set(c.calls)).toEqual(new Set(['miss:203.0.113.7']));
  });
  it('answers 429 on the request that crosses the line, with Retry-After', async () => {
    bindings({ STORE_MISS_LIMITER: counter(1) });
    await countStoreMiss(resolveReq() as any, mkRes());
    const res = mkRes();
    expect(await countStoreMiss(resolveReq() as any, res)).toBe(true);
    expect(res.code).toBe(429);
    expect(res.headers['Retry-After']).toBe('60');
    expect(res.sent).toBe(true);
  });
  it('fails open (a store error never turns a 404 into an outage) and does nothing when not native or no address', async () => {
    bindings({ STORE_MISS_LIMITER: boom });
    expect(await countStoreMiss(resolveReq() as any, mkRes())).toBe(false);
    const c = counter(0);
    bindings({ STORE_MISS_LIMITER: c });
    expect(await countStoreMiss(resolveReq({ ip: undefined }) as any, mkRes())).toBe(false);
    expect(await countStoreMiss(resolveReq({ headers: { cookie: 'a=b' } }) as any, mkRes())).toBe(
      false
    );
    expect(c.calls).toEqual([]);
    clearCfBindings();
    expect(await countStoreMiss(resolveReq() as any, mkRes())).toBe(false);
  });
});

describe('wiring', () => {
  const src = (p: string) => readFileSync(join(__dirname, '../..', p), 'utf8');
  it('the resolve route uses the native wrapper around the exact limiter and counts misses on all three 404 exits', () => {
    const routes = src('apps/api/src/routes/public.routes.ts');
    const seg = routes.slice(
      routes.indexOf('// GET /store/resolve'),
      routes.indexOf('// POST /newsletter/subscribe')
    );
    expect(seg).toContain('storeResolveLimit(storeResolveLimiter)');
    expect((seg.match(/countStoreMiss\(req, res\)/g) ?? []).length).toBe(3);
  });
  it('wrangler declares both new bindings with the exact limiters numbers (30/min, 20/min)', () => {
    const w = src('apps/api/wrangler.jsonc');
    expect(w).toMatch(
      /"STORE_RESOLVE_LIMITER",\s*"namespace_id": "1004",\s*"simple": \{ "limit": 30, "period": 60 \}/
    );
    expect(w).toMatch(
      /"STORE_MISS_LIMITER",\s*"namespace_id": "1005",\s*"simple": \{ "limit": 20, "period": 60 \}/
    );
  });
  it('the numbers equal the exact limiters they replace on this route', () => {
    const sec = src('apps/api/src/middleware/security.ts');
    expect(sec).toMatch(
      /storeResolveLimiter = plannedRateLimit\('store-resolve', \{[\s\S]*?max: 30,/
    ); // PERF-BATCH-1 planned the same limiter: same numbers
    expect(sec).toMatch(/const max = opts\?\.max \?\? 20;/);
  });
});

describe('boot warning when a binding is missing (multi-service env drift)', () => {
  beforeEach(() => resetStoreResolveBindingWarning());
  it('warns ONCE per isolate, naming the missing bindings', () => {
    const warn = vi.fn();
    expect(
      warnMissingStoreResolveBindings({ PUBLIC_IP_LIMITER: counter(1) }, { warn } as any)
    ).toBe(true);
    expect(warnMissingStoreResolveBindings({}, { warn } as any)).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toEqual({
      missingBindings: ['STORE_RESOLVE_LIMITER', 'STORE_MISS_LIMITER'],
    });
    expect(String(warn.mock.calls[0][1])).toContain(
      'falls back to the AuthState Durable Object limiters'
    );
  });
  it('is silent when all three are present', () => {
    const warn = vi.fn();
    const c = counter(1);
    expect(
      warnMissingStoreResolveBindings(
        { PUBLIC_IP_LIMITER: c, STORE_RESOLVE_LIMITER: c, STORE_MISS_LIMITER: c },
        { warn } as any
      )
    ).toBe(false);
    expect(warn).not.toHaveBeenCalled();
  });
  it('prepare() in worker.ts calls it with the deployed env', () => {
    const w = readFileSync(join(__dirname, '../../apps/api/src/worker.ts'), 'utf8');
    expect(w).toContain('warnMissingStoreResolveBindings(env);');
  });
});
