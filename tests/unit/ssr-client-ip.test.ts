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
  SSR_AUTH_HEADER,
  SSR_FORWARD_ROUTES,
  __resetSsrClientIpForTests,
  isForwardableRead,
  resolveClientAddress,
  shouldWarnNoSecret,
} from '@api/cf/ssr-client-ip';
import { publicLimiter, storeResolveLimiter } from '@api/middleware/security';
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

  it('deletes a typed X-Forwarded-For when there is no cf-connecting-ip and no valid forward', async () => {
    const r = await resolveClientAddress(
      apiRequest('/api/v1/public/products', { 'x-forwarded-for': '6.6.6.6' }),
      SECRET
    );
    expect(r.ip).toBeNull();
    expect(r.request.headers.has('x-forwarded-for')).toBe(false);
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

  it('adds neither header with no shopper address or no secret', async () => {
    const noIp = new Request('https://storedemo.ebda.app/');
    await withClientAddress(noIp, SECRET, () => fetch(`${API}/api/v1/public/products`));
    const withIp = new Request('https://storedemo.ebda.app/', {
      headers: { 'cf-connecting-ip': '203.0.113.7' },
    });
    await withClientAddress(withIp, undefined, () => fetch(`${API}/api/v1/public/products`));
    for (const s of seen) {
      expect(s.headers.has(CLIENT_IP_HEADER)).toBe(false);
      expect(s.headers.has(SSR_AUTH_HEADER)).toBe(false);
    }
  });
});

describe('limiters key on the resolved address', () => {
  let server: Server;
  let base: string;
  beforeAll(async () => {
    const app = express();
    app.set('trust proxy', 1); // as the Worker's Express: X-Forwarded-For is set by worker.ts only
    app.get('/api/v1/public/products', publicLimiter, (_req, res) => res.json({ ok: true }));
    await new Promise<void>(r => {
      server = app.listen(0, r);
    });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>(r => server.close(() => r())));

  /** storefront render (signed forward from the Worker's egress) -> API worker resolution -> Express. */
  async function renderFor(shopper: string): Promise<number> {
    const auth = await signClientIp(SECRET, shopper);
    const { request } = await resolveClientAddress(
      apiRequest('/api/v1/public/products', {
        'cf-connecting-ip': WORKER_EGRESS,
        [CLIENT_IP_HEADER]: shopper,
        [SSR_AUTH_HEADER]: auth,
      }),
      SECRET
    );
    const res = await realFetchTo(base + '/api/v1/public/products', request.headers);
    return Number(res.headers.get('ratelimit-remaining'));
  }
  const realFetchTo = (url: string, h: Headers) =>
    fetch(url, { headers: { 'x-forwarded-for': h.get('x-forwarded-for') ?? '' } });

  it('two shoppers rendered by the storefront get two budgets', async () => {
    const a1 = await renderFor('203.0.113.21');
    const a2 = await renderFor('203.0.113.21');
    const b1 = await renderFor('203.0.113.22');
    expect(a2).toBe(a1 - 1);
    expect(b1).toBe(a1);
  });

  it.each([
    ['publicLimiter', publicLimiter],
    ['storeResolveLimiter', storeResolveLimiter],
  ])('%s does not count (no shared bucket) a request with no address', async (_n, limiter) => {
    const app = express();
    app.use((req, _res, next) => {
      Object.defineProperty(req, 'ip', { value: undefined });
      next();
    });
    app.get('/x', limiter as RequestHandler, (_req, res) => res.json({ ok: true }));
    const srv = await new Promise<Server>(r => {
      const x = app.listen(0, () => r(x));
    });
    const res = await fetch(`http://127.0.0.1:${(srv.address() as AddressInfo).port}/x`);
    expect(res.status).toBe(200);
    expect(res.headers.has('ratelimit-remaining')).toBe(false);
    await new Promise<void>(r => srv.close(() => r()));
  });
});
