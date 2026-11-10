/**
 * An unknown store id in a public path is limited and counted like an unknown slug.
 *
 * `publicStoreContext` runs in FRONT of the public router's limiters. It used to answer the directory's 404
 * STORE_NOT_FOUND itself, so `/public/<random uuid>/...` went past every limiter: no RateLimit header, no store-miss
 * count (measured on production 2026-11-10). It now holds the refusal back and `refuseUnknownPublicStore`, mounted right
 * after the limiters, raises it. Removing either half is in the defence-mutation record
 * (docs/security/defence-mutations.json: `public-unknown-store-reaches-the-limiters`,
 * `public-unknown-store-refused-after-the-limiters`).
 *
 * The same behaviour on workerd with the real router and counter: apps/api/workers-test/failure-only-limiters.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import express from 'express';
import request from 'supertest';
import type { Store } from 'express-rate-limit';

const m = vi.hoisted(() => ({ backendFor: vi.fn(), resolvePublicStoreId: vi.fn() }));

vi.mock('@ebda/database', () => ({
  runInTenantContext: async (_s: unknown, fn: () => Promise<unknown>) => fn(),
  runInStoreScope: async (_s: unknown, fn: () => Promise<unknown>) => fn(),
  runInUserScope: async (_u: unknown, fn: () => Promise<unknown>) => fn(),
}));
vi.mock('@api/lib/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('@api/lib/store-backend', () => ({ backendFor: (id: string) => m.backendFor(id) }));
vi.mock('@api/utils/store-helpers', () => ({
  resolvePublicStoreId: (...a: unknown[]) => m.resolvePublicStoreId(...a),
}));
vi.mock('@api/middleware/auth', () => ({
  authenticateAccounts: vi.fn(),
  liveIdentityMemo: () => ({}),
}));

import { publicStoreContext, refuseUnknownPublicStore } from '@api/middleware/tenant-context';
import { createStoreMissLimiter } from '@api/middleware/security';
import { AppError, errorHandler } from '@api/middleware/error-handler';

const REAL = '11111111-1111-4111-8111-111111111111';
const UNKNOWN = '22222222-2222-4222-8222-222222222222';
const MAX = 3;

function counterStore() {
  const counts = new Map<string, number>();
  const store: Store = {
    init: () => undefined,
    get: async key => {
      const n = counts.get(key);
      return n ? { totalHits: n, resetTime: new Date(Date.now() + 60_000) } : undefined;
    },
    increment: async key => {
      const n = (counts.get(key) ?? 0) + 1;
      counts.set(key, n);
      return { totalHits: n, resetTime: new Date(Date.now() + 60_000) };
    },
    decrement: async () => undefined,
    resetKey: async key => {
      counts.delete(key);
    },
  };
  return { store, counts };
}

/** The mounts of routes/index.ts and public.routes.ts, in their order: context, then the limiter, then the refusal. */
function app(store: Store) {
  const handled: string[] = [];
  const router = express.Router();
  router.use(createStoreMissLimiter({ skip: () => false, max: MAX, store }));
  router.use(refuseUnknownPublicStore);
  router.get('/:storeId/pages/:slug', (req, res) => {
    handled.push(req.params.storeId);
    res.json({ success: true, data: { page: null } });
  });
  const a = express();
  a.set('trust proxy', true);
  a.use('/public', publicStoreContext);
  a.use('/public', router);
  a.use(errorHandler as never);
  const get = (storeId: string, ip: string) =>
    request(a).get(`/public/${storeId}/pages/privacy`).set('x-forwarded-for', ip);
  return { get, handled };
}

beforeEach(() => {
  m.resolvePublicStoreId.mockReset().mockResolvedValue(undefined);
  m.backendFor.mockReset().mockImplementation(async (id: string) => {
    if (id === REAL) return 'do';
    throw new AppError(404, 'STORE_NOT_FOUND', 'Store not found');
  });
});

describe('an unknown store id in a public path', () => {
  it('is a 404 that passed the limiter: it carries the miss budget, is counted, and is refused at the limit', async () => {
    const { store, counts } = counterStore();
    const { get, handled } = app(store);
    const ip = '9.2.0.31';

    const seen: string[] = [];
    for (let i = 0; i < MAX; i++) {
      const res = await get(UNKNOWN, ip);
      expect(res.body.error?.code, `miss ${i + 1}`).toBe('STORE_NOT_FOUND');
      seen.push(`${res.status}:${res.headers['ratelimit-remaining']}`);
      await vi.waitFor(() => expect(counts.get(ip)).toBe(i + 1));
    }
    // misses left BEFORE each response
    expect(seen).toEqual(['404:3', '404:2', '404:1']);

    const blocked = await get(UNKNOWN, ip);
    expect(blocked.status).toBe(429);
    expect(blocked.body.error.code).toBe('RATE_LIMITED');
    // no handler ever ran for a store that does not exist
    expect(handled).toEqual([]);
  });

  it('a store that exists is served and writes nothing', async () => {
    const { store, counts } = counterStore();
    const { get, handled } = app(store);
    const res = await get(REAL, '9.2.0.32');
    expect(res.status).toBe(200);
    expect(res.headers['ratelimit-remaining']).toBe(String(MAX));
    expect(handled).toEqual([REAL]);
    await new Promise(r => setTimeout(r, 20));
    expect(counts.size).toBe(0);
  });

  it('only the unknown-store 404 is held back: an unreadable directory is a 503 straight away', async () => {
    m.backendFor.mockRejectedValue(new AppError(503, 'STORE_BACKEND_UNAVAILABLE', 'x'));
    const { store, counts } = counterStore();
    const { get, handled } = app(store);
    const res = await get(REAL, '9.2.0.33');
    expect(res.status).toBe(503);
    // answered in front of the limiter, as before: no miss budget header
    expect(res.headers['ratelimit-remaining']).toBeUndefined();
    expect(handled).toEqual([]);
    expect(counts.size).toBe(0);
  });

  it('the public router raises the refusal right after its limiters and before any route', () => {
    // The middleware above holds the 404 back; this mount is the only thing that raises it again.
    const src = readFileSync(join(__dirname, '../../apps/api/src/routes/public.routes.ts'), 'utf8');
    const uses = [...src.matchAll(/^router\.(use|get|post|put|patch|delete|all)\((.*)$/gm)].map(
      match => `${match[1]} ${match[2]}`
    );
    const refusal = uses.indexOf('use refuseUnknownPublicStore);');
    expect(refusal).toBeGreaterThan(-1);
    expect(uses[refusal - 1]).toBe('use storeMissLimiter);');
    expect(uses.slice(0, refusal).every(line => line.startsWith('use '))).toBe(true);
    // and the context is mounted nowhere else, so nothing can hold a refusal back without this router behind it
    const index = readFileSync(join(__dirname, '../../apps/api/src/routes/index.ts'), 'utf8');
    expect(index.match(/^router\.use\(.*publicStoreContext.*$/gm)).toEqual([
      "router.use('/public', publicStoreContext);",
    ]);
    expect(
      index.indexOf(
        "router.use('/public', publicStoreContext);\nrouter.use('/public', publicRoutes);"
      )
    ).toBeGreaterThan(-1);
  });
});
