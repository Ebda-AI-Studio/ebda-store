import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import type { Store } from 'express-rate-limit';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  createAuthIpLimiter,
  createStoreMissLimiter,
  createPublicSearchLimiter,
  whenSearching,
} from '../security';

// LAUNCH-RL: every new limiter is built with the test-env skip turned OFF (the exported singletons
// skip under vitest), so the N+1th request is a real 429 with the RATE_LIMITED code and Retry-After.
let server: Server;
let base: string;
const never = () => false;

beforeAll(async () => {
  const app = express();
  app.set('trust proxy', true);
  app.use(express.json());
  app.post(
    '/login',
    createAuthIpLimiter({ countSuccess: false, max: 3, prefix: 't-login', skip: never }),
    (req, res) => (req.body.ok ? res.json({ ok: true }) : res.status(401).json({ ok: false }))
  );
  app.post(
    '/forgot',
    createAuthIpLimiter({ countSuccess: true, max: 3, prefix: 't-forgot', skip: never }),
    (_req, res) => res.json({ ok: true })
  );
  app.get('/stores/:slug', createStoreMissLimiter({ skip: never, max: 3 }), (req, res) =>
    req.params.slug === 'real' ? res.json({ ok: true }) : res.status(404).json({ ok: false })
  );
  const search = createPublicSearchLimiter({ skip: never, max: 3 });
  app.get('/products', whenSearching(search), (_req, res) => res.json({ ok: true }));
  app.get('/suggest', search, (_req, res) => res.json({ ok: true }));
  await new Promise<void>(r => {
    server = app.listen(0, r);
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>(r => server.close(() => r())));

const call = (method: string, path: string, ip: string, body?: unknown, headers = {}) =>
  fetch(base + path, {
    method,
    headers: { 'content-type': 'application/json', 'x-forwarded-for': ip, ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });

describe('auth IP limiter (email rotation does not buy a fresh bucket)', () => {
  it('429s the 4th failed login from one IP even with a different email each time', async () => {
    const s: number[] = [];
    for (let i = 0; i < 4; i++)
      s.push((await call('POST', '/login', '9.0.0.1', { email: `u${i}@x.com` })).status);
    expect(s).toEqual([401, 401, 401, 429]);
    const r = await call('POST', '/login', '9.0.0.1', { email: 'z@x.com' });
    expect(r.headers.get('retry-after')).toBeTruthy();
    expect(((await r.json()) as { error: { code: string } }).error.code).toBe('RATE_LIMITED');
  });
  it('does not count successful sign-ins (shared NAT) and isolates other IPs', async () => {
    for (let i = 0; i < 10; i++)
      expect((await call('POST', '/login', '9.0.0.2', { ok: true })).status).toBe(200);
    expect((await call('POST', '/login', '9.0.0.3', { email: 'a' })).status).toBe(401);
  });
  it('count-everything mode (forgot/register) 429s the 4th request regardless of email', async () => {
    const s: number[] = [];
    for (let i = 0; i < 4; i++)
      s.push((await call('POST', '/forgot', '9.0.0.4', { email: `u${i}@x.com` })).status);
    expect(s).toEqual([200, 200, 200, 429]);
  });
});

describe('store-miss limiter', () => {
  it('429s the 4th unknown-store lookup, never counts hits', async () => {
    for (let i = 0; i < 10; i++)
      expect((await call('GET', '/stores/real', '9.1.0.1')).status).toBe(200);
    const s: number[] = [];
    for (let i = 0; i < 4; i++) s.push((await call('GET', `/stores/nope${i}`, '9.1.0.1')).status);
    expect(s).toEqual([404, 404, 404, 429]);
    expect((await call('GET', '/stores/real', '9.1.0.1')).status).toBe(429); // blocked IP stays blocked this minute
    expect((await call('GET', '/stores/real', '9.1.0.2')).status).toBe(200);
  });
  // LAUNCH-RL-MISS: a hit must not move the miss budget, not after the response and not while it is in flight.
  it('hits leave the budget in the headers untouched; misses bring it down', async () => {
    const left: string[] = [];
    for (let i = 0; i < 6; i++) {
      const r = await call('GET', '/stores/real', '9.1.0.3');
      left.push(`${r.status}:${r.headers.get('ratelimit-remaining')}`);
    }
    expect(left).toEqual(Array.from({ length: 6 }, () => '200:3'));
    const miss: string[] = [];
    for (let i = 0; i < 4; i++) {
      const r = await call('GET', `/stores/nope${i}`, '9.1.0.3');
      miss.push(`${r.status}:${r.headers.get('ratelimit-remaining')}`);
    }
    // the header is the budget BEFORE the response
    expect(miss).toEqual(['404:3', '404:2', '404:1', '429:0']);
  });
  it('30 parallel hits from one IP (a carrier NAT) are all served with a budget of 3', async () => {
    const s = await Promise.all(
      Array.from({ length: 30 }, async () => (await call('GET', '/stores/real', '9.1.0.4')).status)
    );
    expect(s).toEqual(Array.from({ length: 30 }, () => 200));
    expect((await call('GET', '/stores/real', '9.1.0.4')).headers.get('ratelimit-remaining')).toBe(
      '3'
    );
  });
  it('a counter outage serves the request (fail open), reads and writes', async () => {
    const down: Store = {
      init: () => undefined,
      get: async () => {
        throw new Error('store down');
      },
      increment: async () => {
        throw new Error('store down');
      },
      decrement: async () => undefined,
      resetKey: async () => undefined,
    };
    const app = express();
    app.set('trust proxy', true);
    app.get(
      '/stores/:slug',
      createStoreMissLimiter({ skip: never, max: 1, store: down }),
      (req, res) =>
        req.params.slug === 'real' ? res.json({ ok: true }) : res.status(404).json({ ok: false })
    );
    const srv = await new Promise<Server>(r => {
      const x = app.listen(0, () => r(x));
    });
    const url = `http://127.0.0.1:${(srv.address() as AddressInfo).port}/stores/`;
    const unhandled: unknown[] = [];
    const onUnhandled = (e: unknown) => unhandled.push(e);
    process.on('unhandledRejection', onUnhandled);
    const s: number[] = [];
    for (const slug of ['real', 'nope1', 'nope2', 'nope3'])
      s.push((await fetch(url + slug, { headers: { 'x-forwarded-for': '9.1.0.5' } })).status);
    await new Promise(r => setTimeout(r, 50));
    process.off('unhandledRejection', onUnhandled);
    await new Promise<void>(r => srv.close(() => r()));
    expect(s).toEqual([200, 404, 404, 404]);
    expect(unhandled).toEqual([]);
  });
  it('a request with no client IP is never counted', async () => {
    const app = express();
    app.use((req, _res, next) => {
      Object.defineProperty(req, 'ip', { value: undefined });
      next();
    });
    app.get('/stores/:slug', createStoreMissLimiter({ skip: never, max: 1 }), (_req, res) =>
      res.status(404).json({ ok: false })
    );
    const srv = await new Promise<Server>(r => {
      const x = app.listen(0, () => r(x));
    });
    const url = `http://127.0.0.1:${(srv.address() as AddressInfo).port}/stores/x`;
    for (let i = 0; i < 4; i++) expect((await fetch(url)).status).toBe(404);
    await new Promise<void>(r => srv.close(() => r()));
  });
});

describe('public search limiter', () => {
  it('429s the 4th search (query or header) but never a plain list read', async () => {
    for (let i = 0; i < 10; i++)
      expect((await call('GET', '/products', '9.2.0.1')).status).toBe(200);
    const s: number[] = [];
    for (let i = 0; i < 4; i++)
      s.push((await call('GET', `/products?search=a${i}`, '9.2.0.2')).status);
    expect(s).toEqual([200, 200, 200, 429]);
    const h = [];
    for (let i = 0; i < 4; i++)
      h.push(
        (await call('GET', '/products', '9.2.0.3', undefined, { 'x-search-query': 'abc' })).status
      );
    expect(h).toEqual([200, 200, 200, 429]);
  });
  it('429s the 4th suggest call', async () => {
    const s: number[] = [];
    for (let i = 0; i < 4; i++) s.push((await call('GET', '/suggest', '9.2.0.4')).status);
    expect(s).toEqual([200, 200, 200, 429]);
  });
});

describe('no resolvable client IP', () => {
  it('is not counted (no shared bucket)', async () => {
    const app = express();
    app.use((req, _res, next) => {
      Object.defineProperty(req, 'ip', { value: undefined });
      next();
    });
    app.get('/s', createPublicSearchLimiter({ skip: never, max: 2 }), (_req, res) =>
      res.json({ ok: true })
    );
    const srv = await new Promise<Server>(r => {
      const x = app.listen(0, () => r(x));
    });
    const url = `http://127.0.0.1:${(srv.address() as AddressInfo).port}/s`;
    for (let i = 0; i < 5; i++) expect((await fetch(url)).status).toBe(200);
    await new Promise<void>(r => srv.close(() => r()));
  });
});
