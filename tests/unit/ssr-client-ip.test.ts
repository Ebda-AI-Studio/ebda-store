/**
 * Ruling RL-SSR-IP-6: a storefront server render is charged to the shopper's address, and nothing on the
 * internet can choose the address the API counts.
 *  - apps/web/ssr-client-address.ts signs the shopper address on API-origin fetches;
 *  - apps/api/src/cf/ssr-client-ip.ts strips, verifies and applies it before Express;
 *  - publicLimiter / storeResolveLimiter key on the address and never pool requests with none.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express, { type RequestHandler } from 'express';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  CLIENT_IP_HEADER,
  NO_CLIENT_ADDRESS_HEADER,
  SSR_AUTH_HEADER,
  SSR_FORWARD_ROUTES,
  TRUSTED_SSR_HEADER,
  trustedSsrRequests,
  __resetSsrClientIpForTests,
  isForwardableRead,
  resolveClientAddress,
  shouldWarnNoSecret,
} from '@api/cf/ssr-client-ip';
import { publicLimiter, storeResolveLimiter } from '@api/middleware/security';
import { isTrustedSsr } from '@api/middleware/public-limiter-keys';
import {
  __resetForTests as resetStorefront,
  installApiFetchForwarding,
  signClientIp,
  withClientAddress,
} from '../../apps/web/ssr-client-address';

const SECRET = 'test-revalidate-secret';
const API = 'https://api.ebda.app';
const WORKER_EGRESS = '2a06:98c0:3600::103';
const ROOT = join(__dirname, '../..');

function apiRequest(path: string, headers: Record<string, string>, method = 'GET'): Request {
  return new Request(API + path, { method, headers });
}

describe('API: forwarded shopper address (cf/ssr-client-ip.ts)', () => {
  it('honours a valid storefront forward on an anonymous storefront read, and strips both headers', async () => {
    const auth = await signClientIp(SECRET, '203.0.113.7');
    const r = await resolveClientAddress(
      apiRequest('/api/v1/public/products', {
        'cf-connecting-ip': WORKER_EGRESS,
        [CLIENT_IP_HEADER]: '203.0.113.7',
        [SSR_AUTH_HEADER]: auth,
      }),
      SECRET
    );
    expect(r).toMatchObject({ ip: '203.0.113.7', forwarded: true });
    expect(r.request.headers.get('x-forwarded-for')).toBe('203.0.113.7');
    expect(r.request.headers.has(CLIENT_IP_HEADER)).toBe(false);
    expect(r.request.headers.has(SSR_AUTH_HEADER)).toBe(false);
  });

  it.each([
    ['no signature', '203.0.113.7', null],
    ['a wrong signature', '203.0.113.7', 'ab'.repeat(32)],
    ['a signature for another address', '203.0.113.7', 'sign:198.51.100.1'],
    ['a signature made with another secret', '203.0.113.7', 'other-secret'],
    ['a value that is not an IP', 'evil.example', 'sign:evil.example'],
  ])('ignores a forward from the internet with %s', async (_label, claimed, authSpec) => {
    let auth: string | null = authSpec;
    if (authSpec?.startsWith('sign:')) auth = await signClientIp(SECRET, authSpec.slice(5));
    if (authSpec === 'other-secret') auth = await signClientIp('other-secret', claimed);
    const headers: Record<string, string> = {
      'cf-connecting-ip': '198.51.100.50',
      'x-forwarded-for': '10.0.0.1',
      [CLIENT_IP_HEADER]: claimed,
    };
    if (auth) headers[SSR_AUTH_HEADER] = auth;
    const r = await resolveClientAddress(apiRequest('/api/v1/public/products', headers), SECRET);
    expect(r).toMatchObject({ ip: '198.51.100.50', forwarded: false });
    expect(r.request.headers.get('x-forwarded-for')).toBe('198.51.100.50');
    expect(r.request.headers.has(CLIENT_IP_HEADER)).toBe(false);
    expect(r.request.headers.has(SSR_AUTH_HEADER)).toBe(false);
  });

  it('trusts nothing when the API has no REVALIDATE_SECRET, and says so once', async () => {
    const auth = await signClientIp(SECRET, '203.0.113.7');
    const r = await resolveClientAddress(
      apiRequest('/api/v1/public/products', {
        'cf-connecting-ip': WORKER_EGRESS,
        [CLIENT_IP_HEADER]: '203.0.113.7',
        [SSR_AUTH_HEADER]: auth,
      }),
      undefined
    );
    expect(r).toMatchObject({ ip: WORKER_EGRESS, forwarded: false });
    __resetSsrClientIpForTests();
    expect(shouldWarnNoSecret(SECRET)).toBe(false);
    expect([
      shouldWarnNoSecret(undefined),
      shouldWarnNoSecret(''),
      shouldWarnNoSecret(undefined),
    ]).toEqual([true, false, false]);
    const worker = readFileSync(join(ROOT, 'apps/api/src/worker.ts'), 'utf8');
    expect(worker).toMatch(
      /if \(shouldWarnNoSecret\(secret\)\) \{\s*logger\.error\(\s*'SSR client address OFF: REVALIDATE_SECRET/
    );
  });

  it.each([
    ['POST', '/api/v1/auth/login'],
    ['POST', '/api/v1/public/products'],
    ['GET', '/api/v1/public/orders'],
    ['GET', '/api/v1/public/cart'],
    ['GET', '/api/v1/stores/s1/orders'],
  ])(
    'ignores a VALID forward on %s %s (not an anonymous storefront read)',
    async (method, path) => {
      const auth = await signClientIp(SECRET, '203.0.113.7');
      const r = await resolveClientAddress(
        apiRequest(
          path,
          {
            'cf-connecting-ip': WORKER_EGRESS,
            [CLIENT_IP_HEADER]: '203.0.113.7',
            [SSR_AUTH_HEADER]: auth,
          },
          method
        ),
        SECRET
      );
      expect(r).toMatchObject({ ip: WORKER_EGRESS, forwarded: false });
      expect(r.request.headers.has(SSR_AUTH_HEADER)).toBe(false);
    }
  );

  it('a signed `none` (storefront render, no shopper) on a storefront read = no address; unsigned or on a write = ignored', async () => {
    const none = await signClientIp(SECRET, 'none');
    const base = {
      'cf-connecting-ip': WORKER_EGRESS,
      'x-forwarded-for': '6.6.6.6',
      [CLIENT_IP_HEADER]: 'none',
    };
    const ok = await resolveClientAddress(
      apiRequest('/api/v1/public/store/resolve', { ...base, [SSR_AUTH_HEADER]: none }),
      SECRET
    );
    expect(ok).toMatchObject({ ip: null, forwarded: true });
    expect(ok.request.headers.has('x-forwarded-for')).toBe(false);
    const unsigned = await resolveClientAddress(
      apiRequest('/api/v1/public/store/resolve', { ...base, [SSR_AUTH_HEADER]: 'ab'.repeat(32) }),
      SECRET
    );
    expect(unsigned).toMatchObject({ ip: WORKER_EGRESS, forwarded: false });
    const write = await resolveClientAddress(
      apiRequest('/api/v1/auth/login', { ...base, [SSR_AUTH_HEADER]: none }, 'POST'),
      SECRET
    );
    expect(write).toMatchObject({ ip: WORKER_EGRESS, forwarded: false });
  });

  it('deletes a typed X-Forwarded-For when there is no cf-connecting-ip and no valid forward', async () => {
    const r = await resolveClientAddress(
      apiRequest('/api/v1/public/products', { 'x-forwarded-for': '6.6.6.6' }),
      SECRET
    );
    expect(r.ip).toBeNull();
    expect(r.request.headers.has('x-forwarded-for')).toBe(false);
    expect(r.request.headers.get(NO_CLIENT_ADDRESS_HEADER)).toBe('1');
    // and a caller can never set the marker itself
    const typed = await resolveClientAddress(
      apiRequest('/api/v1/public/products', {
        'cf-connecting-ip': '198.51.100.50',
        [NO_CLIENT_ADDRESS_HEADER]: '1',
      }),
      SECRET
    );
    expect(typed.ip).toBe('198.51.100.50');
    expect(typed.request.headers.has(NO_CLIENT_ADDRESS_HEADER)).toBe(false);
  });

  it('every GET route of the storefront render routers is classified (forward or own)', () => {
    const routes = new Set<string>();
    for (const f of ['routes/public.routes.ts', 'routes/public-store-layout.routes.ts']) {
      const src = readFileSync(join(ROOT, 'apps/api/src', f), 'utf8');
      for (const m of src.matchAll(/router\.(?:get|head)\(\s*'([^']+)'/g)) routes.add(m[1]);
    }
    expect(routes.size).toBeGreaterThan(10);
    const unclassified = [...routes].filter(r => !(r in SSR_FORWARD_ROUTES));
    expect(unclassified, 'classify these in SSR_FORWARD_ROUTES (cf/ssr-client-ip.ts)').toEqual([]);
    const stale = Object.keys(SSR_FORWARD_ROUTES).filter(r => !routes.has(r));
    expect(stale, 'SSR_FORWARD_ROUTES names a route that no longer exists').toEqual([]);
    expect(isForwardableRead('GET', '/api/v1/public/stores/abc/layout')).toBe(true);
    expect(isForwardableRead('HEAD', '/api/v1/public/products/x')).toBe(true);
    expect(isForwardableRead('GET', '/api/v1/public/stores/abc/builder-preview')).toBe(false);
  });
});

describe('storefront: API-origin fetches carry the signed shopper address (apps/web/ssr-client-address.ts)', () => {
  const realFetch = globalThis.fetch;
  const seen: Array<{ url: string; headers: Headers; init?: RequestInit }> = [];
  beforeAll(() => {
    resetStorefront();
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      seen.push({ url, headers: new Headers(init?.headers), init });
      return new Response('ok');
    }) as typeof fetch;
    installApiFetchForwarding(API);
  });
  afterEach(() => {
    seen.length = 0;
  });
  afterAll(() => {
    globalThis.fetch = realFetch;
    resetStorefront();
  });

  it('adds both headers to API-origin fetches only, and keeps other init fields', async () => {
    const shopper = new Request('https://storedemo.ebda.app/', {
      headers: { 'cf-connecting-ip': '203.0.113.7' },
    });
    await withClientAddress(shopper, SECRET, async () => {
      await new Promise(r => setTimeout(r, 1)); // across an async boundary, like a render
      await fetch(`${API}/api/v1/public/products`, {
        headers: { 'x-store-id': 's1' },
        next: { revalidate: 60 },
      } as RequestInit);
      await fetch('https://cdn.example.com/x.png');
      await fetch(new Request(`${API}/api/v1/public/categories`));
    });
    await fetch(`${API}/api/v1/public/tags`); // outside any request
    const expected = await signClientIp(SECRET, '203.0.113.7');
    const [products, cdn, categories, outside] = seen;
    expect(products.headers.get(CLIENT_IP_HEADER)).toBe('203.0.113.7');
    expect(products.headers.get(SSR_AUTH_HEADER)).toBe(expected);
    expect(products.headers.get('x-store-id')).toBe('s1');
    expect((products.init as { next?: unknown }).next).toEqual({ revalidate: 60 });
    expect(categories.headers.get(SSR_AUTH_HEADER)).toBe(expected);
    expect(cdn.headers.has(CLIENT_IP_HEADER)).toBe(false);
    expect(cdn.headers.has(SSR_AUTH_HEADER)).toBe(false);
    expect(outside.headers.has(CLIENT_IP_HEADER)).toBe(false);
  });

  it('adds neither header with no secret; with no shopper address it forwards the signed `none`', async () => {
    const withIp = new Request('https://storedemo.ebda.app/', {
      headers: { 'cf-connecting-ip': '203.0.113.7' },
    });
    await withClientAddress(withIp, undefined, () => fetch(`${API}/api/v1/public/products`));
    const noIp = new Request('https://storedemo.ebda.app/'); // OpenNext background revalidation
    await withClientAddress(noIp, SECRET, () => fetch(`${API}/api/v1/public/store/resolve`));
    expect(seen[0].headers.has(CLIENT_IP_HEADER)).toBe(false);
    expect(seen[0].headers.has(SSR_AUTH_HEADER)).toBe(false);
    expect(seen[1].headers.get(CLIENT_IP_HEADER)).toBe('none');
    expect(seen[1].headers.get(SSR_AUTH_HEADER)).toBe(await signClientIp(SECRET, 'none'));
  });

  it('does not follow a redirect with the signed headers unless the caller asked to', async () => {
    const shopper = new Request('https://storedemo.ebda.app/', {
      headers: { 'cf-connecting-ip': '203.0.113.7' },
    });
    await withClientAddress(shopper, SECRET, async () => {
      await fetch(`${API}/api/v1/public/products`);
      await fetch(new Request(`${API}/api/v1/public/categories`));
      await fetch(`${API}/api/v1/public/tags`, { redirect: 'follow' });
      await fetch('https://cdn.example.com/x.png');
    });
    expect(seen.map(s => s.init?.redirect)).toEqual(['manual', 'manual', 'follow', undefined]);
  });
});

describe("storefront wrapper sits BELOW Next's fetch cache (the forward headers never enter its key)", () => {
  const NEXT_PATCH = Symbol.for('next-patch');
  const realFetch = globalThis.fetch;
  const net: Headers[] = [];
  afterEach(() => {
    globalThis.fetch = realFetch;
    delete (globalThis as Record<symbol, unknown>)[NEXT_PATCH];
    resetStorefront();
    net.length = 0;
  });
  const fakeNetwork = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    net.push(new Headers(init?.headers));
    return new Response('ok');
  }) as typeof fetch;

  it('the forward headers WOULD split the cache key if Next saw them (why the order matters)', async () => {
    const { IncrementalCache } = await import('next/dist/server/lib/incremental-cache');
    const key = (headers: Record<string, string>) =>
      IncrementalCache.prototype.generateCacheKey.call(
        { fetchCacheKeyPrefix: '' },
        `${API}/api/v1/public/products`,
        {
          headers,
        }
      );
    const a = await signClientIp(SECRET, '203.0.113.1');
    const b = await signClientIp(SECRET, '203.0.113.2');
    expect(await key({ [CLIENT_IP_HEADER]: '203.0.113.1', [SSR_AUTH_HEADER]: a })).not.toBe(
      await key({ [CLIENT_IP_HEADER]: '203.0.113.2', [SSR_AUTH_HEADER]: b })
    );
  });

  it("Next's real patchFetch, applied after our install (as on workerd), wraps us: Next keys the caller's init, the network gets the headers", async () => {
    globalThis.fetch = fakeNetwork;
    expect(installApiFetchForwarding(API)).toBe(true);
    const ours = globalThis.fetch;
    // patchFetch() = createPatchedFetcher(createDedupeFetch(globalThis.fetch)); the dedupe layer needs React's
    // server build, so the test applies the cache layer itself, over whatever globalThis.fetch is at that moment.
    const { createPatchedFetcher } = await import('next/dist/server/lib/patch-fetch');
    const noStore = { getStore: () => undefined };
    globalThis.fetch = createPatchedFetcher(globalThis.fetch, {
      workAsyncStorage: noStore,
      workUnitAsyncStorage: noStore,
    } as never) as typeof fetch;
    const nextFetch = globalThis.fetch as typeof fetch & { _nextOriginalFetch?: unknown };
    expect(nextFetch).not.toBe(ours); // Next is the outer layer
    expect(typeof nextFetch._nextOriginalFetch).toBe('function');
    const { IncrementalCache } = await import('next/dist/server/lib/incremental-cache');
    const keys: string[] = [];
    for (const ip of ['203.0.113.1', '203.0.113.2']) {
      const shopper = new Request('https://storedemo.ebda.app/', {
        headers: { 'cf-connecting-ip': ip },
      });
      const init: RequestInit = { headers: { 'x-store-id': 's1' } };
      await withClientAddress(shopper, SECRET, () => fetch(`${API}/api/v1/public/products`, init));
      // What Next keys on is the caller's init at its own layer: the same for both shoppers.
      keys.push(
        await IncrementalCache.prototype.generateCacheKey.call(
          { fetchCacheKeyPrefix: '' },
          `${API}/api/v1/public/products`,
          init
        )
      );
    }
    expect(keys[0]).toBe(keys[1]);
    expect(net.map(h => h.get(CLIENT_IP_HEADER))).toEqual(['203.0.113.1', '203.0.113.2']);
  });

  it('refuses to install (forwards nothing) when Next has already patched fetch', async () => {
    globalThis.fetch = fakeNetwork;
    (globalThis as Record<symbol, unknown>)[NEXT_PATCH] = true;
    expect(installApiFetchForwarding(API)).toBe(false);
    expect(globalThis.fetch).toBe(fakeNetwork);
  });
});

describe('limiters key on the resolved address (real storefront wrapper -> API resolution -> Express)', () => {
  let server: Server;
  let base: string;
  const realFetch = globalThis.fetch;
  beforeAll(async () => {
    const app = express();
    // One connection per request: undici pools sockets, and under host load a pooled socket the server had already
    // closed (keep-alive timeout) was reused -> "fetch failed / SocketError: other side closed" (26/26 alone, 3 failed
    // in the loaded pre-push run).
    app.use((_req, res, next) => {
      res.setHeader('Connection', 'close');
      next();
    });
    app.set('trust proxy', 1); // as the Worker's Express: X-Forwarded-For is set by worker.ts only
    // app.ts: the Worker's no-address marker leaves req.ip empty (workers-test/search-limiter-key.test.ts proves the
    // whole chain on workerd).
    app.use((req, _res, next) => {
      if (req.headers[NO_CLIENT_ADDRESS_HEADER])
        Object.defineProperty(req, 'ip', { value: undefined });
      next();
    });
    app.get('/api/v1/public/products', publicLimiter, (_req, res) => res.json({ ok: true }));
    app.get('/api/v1/public/store/resolve', publicLimiter, storeResolveLimiter, (_req, res) =>
      res.json({ ok: true })
    );
    await new Promise<void>(r => {
      server = app.listen(0, r);
    });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    // The storefront Worker's outbound network: the API Worker sees the storefront's egress address as
    // cf-connecting-ip and resolves the forward (cf/ssr-client-ip.ts) before Express.
    resetStorefront();
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const headers = new Headers(init?.headers);
      headers.set('cf-connecting-ip', WORKER_EGRESS);
      const { request } = await resolveClientAddress(new Request(url, { headers }), SECRET);
      const xff = request.headers.get('x-forwarded-for');
      const marker = request.headers.get(NO_CLIENT_ADDRESS_HEADER);
      const out: Record<string, string> = {};
      if (xff) out['x-forwarded-for'] = xff;
      if (marker) out[NO_CLIENT_ADDRESS_HEADER] = marker;
      return realFetch(base + new URL(url).pathname, { headers: out });
    }) as typeof fetch;
    installApiFetchForwarding(API);
  });
  afterAll(async () => {
    globalThis.fetch = realFetch;
    resetStorefront();
    await new Promise<void>(r => server.close(() => r()));
  });

  /** One server-side API fetch made while rendering for `shopper` (null = no shopper: background revalidation). */
  async function renderFor(shopper: string | null, path: string): Promise<Response> {
    const headers: Record<string, string> = shopper ? { 'cf-connecting-ip': shopper } : {};
    const incoming = new Request('https://storedemo.ebda.app/', { headers });
    return withClientAddress(incoming, SECRET, () => fetch(`${API}${path}`));
  }
  const remaining = (r: Response) => Number(r.headers.get('ratelimit-remaining'));

  it('two shoppers rendered by the storefront get two publicLimiter budgets', async () => {
    const a1 = remaining(await renderFor('203.0.113.21', '/api/v1/public/products'));
    const a2 = remaining(await renderFor('203.0.113.21', '/api/v1/public/products'));
    const b1 = remaining(await renderFor('203.0.113.22', '/api/v1/public/products'));
    expect(a2).toBe(a1 - 1);
    expect(b1).toBe(a1);
  });

  it('two shoppers rendered by the storefront get two store-resolve budgets (30/min each, not one shared)', async () => {
    const statusA: number[] = [];
    for (let i = 0; i < 31; i++)
      statusA.push((await renderFor('203.0.113.61', '/api/v1/public/store/resolve')).status);
    expect(statusA.slice(0, 30).every(s => s === 200)).toBe(true);
    expect(statusA[30]).toBe(429);
    expect((await renderFor('203.0.113.62', '/api/v1/public/store/resolve')).status).toBe(200);
  });

  it('a storefront render with no shopper is counted in NO per-address bucket (store resolve + public reads)', async () => {
    for (let i = 0; i < 35; i++) {
      const r = await renderFor(null, '/api/v1/public/store/resolve');
      expect(r.status).toBe(200);
      expect(r.headers.has('ratelimit-remaining')).toBe(false);
    }
  });

  it.each([
    ['publicLimiter', publicLimiter],
    ['storeResolveLimiter', storeResolveLimiter],
  ])('%s does not count (no shared bucket) a request with no address', async (_n, limiter) => {
    const app = express();
    // One connection per request: undici pools sockets, and under host load a pooled socket the server had already
    // closed (keep-alive timeout) was reused -> "fetch failed / SocketError: other side closed" (26/26 alone, 3 failed
    // in the loaded pre-push run).
    app.use((_req, res, next) => {
      res.setHeader('Connection', 'close');
      next();
    });
    app.use((req, _res, next) => {
      Object.defineProperty(req, 'ip', { value: undefined });
      next();
    });
    app.get('/x', limiter as RequestHandler, (_req, res) => res.json({ ok: true }));
    const srv = await new Promise<Server>(r => {
      const x = app.listen(0, () => r(x));
    });
    const res = await realFetch(`http://127.0.0.1:${(srv.address() as AddressInfo).port}/x`);
    expect(res.status).toBe(200);
    expect(res.headers.has('ratelimit-remaining')).toBe(false);
    await new Promise<void>(r => srv.close(() => r()));
  });
});

describe('Ruling DO-BUDGET-2: only a storefront render with a VERIFIED signature skips the public read buckets', () => {
  const addr = '203.0.113.7';
  it('marks a verified forward as trusted (marker set by the Worker only)', async () => {
    const auth = await signClientIp(SECRET, addr);
    const r = await resolveClientAddress(
      apiRequest('/api/v1/public/store/resolve', {
        'cf-connecting-ip': WORKER_EGRESS,
        [CLIENT_IP_HEADER]: addr,
        [SSR_AUTH_HEADER]: auth,
      }),
      SECRET
    );
    expect(r.request.headers.get(TRUSTED_SSR_HEADER)).toBe('1');
  });

  it.each([
    ['a typed marker alone', {}],
    ['a typed marker + claimed address, no signature', { [CLIENT_IP_HEADER]: addr }],
    [
      'a typed marker + wrong signature',
      { [CLIENT_IP_HEADER]: addr, [SSR_AUTH_HEADER]: 'ab'.repeat(32) },
    ],
    ['a typed marker + x-forwarded-for', { 'x-forwarded-for': addr }],
  ])('never trusts %s from the internet, and removes the typed marker', async (_l, extra) => {
    const r = await resolveClientAddress(
      apiRequest('/api/v1/public/store/resolve', {
        'cf-connecting-ip': '198.51.100.50',
        [TRUSTED_SSR_HEADER]: '1',
        ...extra,
      }),
      SECRET
    );
    expect(r.request.headers.has(TRUSTED_SSR_HEADER)).toBe(false);
  });

  it('a valid signature on a WRITE or with no API secret is not trusted', async () => {
    const auth = await signClientIp(SECRET, addr);
    const h = {
      'cf-connecting-ip': WORKER_EGRESS,
      [CLIENT_IP_HEADER]: addr,
      [SSR_AUTH_HEADER]: auth,
    };
    const write = await resolveClientAddress(
      apiRequest('/api/v1/public/store/resolve', h, 'POST'),
      SECRET
    );
    expect(write.request.headers.has(TRUSTED_SSR_HEADER)).toBe(false);
    const noSecret = await resolveClientAddress(
      apiRequest('/api/v1/public/store/resolve', h),
      undefined
    );
    expect(noSecret.request.headers.has(TRUSTED_SSR_HEADER)).toBe(false);
  });

  it('isTrustedSsr is WeakSet membership: a header on the Express request means nothing', () => {
    const forged = { headers: { [TRUSTED_SSR_HEADER]: '1' } } as never;
    expect(isTrustedSsr(forged)).toBe(false);
    const ok = {} as never;
    trustedSsrRequests.add(ok);
    expect(isTrustedSsr(ok)).toBe(true);
  });
});
