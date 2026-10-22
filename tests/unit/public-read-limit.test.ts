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
import {
  publicReadLimit,
  isAnonymousPublicRead,
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
  ip: '1.1.1.1',
  headers: { 'x-store-domain': 'a.ebda.app' },
  ...extra,
});

beforeEach(() => clearCfBindings());
afterEach(() => clearCfBindings());

describe('who counts as an anonymous public read', () => {
  it.each([
    [{ method: 'GET', headers: {} }, true],
    [{ method: 'HEAD', headers: {} }, true],
    [{ method: 'POST', headers: {} }, false],
    [{ method: 'PUT', headers: {} }, false],
    [{ method: 'DELETE', headers: {} }, false],
    [{ method: 'GET', headers: { authorization: 'Bearer x' } }, false],
    [{ method: 'GET', headers: { cookie: 'token=abc' } }, false],
    [{ method: 'GET', headers: { cookie: 'anything=1' } }, false],
  ])('%j -> %s', (req, want) => {
    expect(isAnonymousPublicRead(req as any)).toBe(want);
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
