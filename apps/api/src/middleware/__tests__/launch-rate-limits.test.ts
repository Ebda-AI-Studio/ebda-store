import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
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
