/**
 * LAUNCH-RL-MISS-3 (docs/rulings/LAUNCH-RL-MISS-3.md): the ONE kind of 404 the store-miss limiter does not count.
 *
 * Every 404 is a counted miss by default. A dead product or blog link is left uncounted only when all three hold:
 * the resolver verified a store for the request, the route that answered is on the catalogue-miss list, and the
 * route's own store id is the verified one. Each condition, and the count for an unverified store, has a defence
 * mutation that this file must turn red (docs/security/defence-mutations.json: `store-miss-exempt-needs-verified-store`,
 * `store-miss-exempt-needs-listed-route`, `store-miss-exempt-needs-same-store`, `store-miss-unverified-store-is-counted`).
 *
 * The app below is synthetic so the unit tier can run it with no database: the "resolver" calls the real
 * `setResolvedStoreId` for the two stores it knows, exactly what `resolvePublicStoreId` does after its lookup. The real
 * router on the real runtime (workerd, every public route walked) is apps/api/workers-test/failure-only-limiters.test.ts.
 */
import { describe, it, expect, vi } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import express from 'express';
import request from 'supertest';
import type { Store } from 'express-rate-limit';
import { createStoreMissLimiter } from '@api/middleware/security';
import { CATALOGUE_MISS_ROUTES, catalogueMissRoute } from '@api/middleware/catalogue-miss';
import { setResolvedStoreId } from '@api/utils/resolved-store';

const never = () => false;
const STORE_A = '11111111-1111-4111-8111-111111111111';
const STORE_B = '22222222-2222-4222-8222-222222222222';
const UNKNOWN = '99999999-9999-4999-8999-999999999999';
const KNOWN = new Set([STORE_A, STORE_B]);
const MAX = 3;

function counterStore() {
  const counts = new Map<string, number>();
  const writes: string[] = [];
  const store: Store = {
    init: () => undefined,
    get: async key => {
      const n = counts.get(key);
      return n ? { totalHits: n, resetTime: new Date(Date.now() + 60_000) } : undefined;
    },
    increment: async key => {
      writes.push(`+${key}`);
      const n = (counts.get(key) ?? 0) + 1;
      counts.set(key, n);
      return { totalHits: n, resetTime: new Date(Date.now() + 60_000) };
    },
    decrement: async key => {
      writes.push(`-${key}`);
    },
    resetKey: async key => {
      counts.delete(key);
    },
  };
  return { store, writes };
}

/**
 * The public router's shape: resolver, then the limiter over everything, then the routes. `live` answers 200.
 * A request names its store the way the storefront does (`X-Store-ID`); the path id is never proof.
 */
function app(store: Store) {
  const a = express();
  a.set('trust proxy', true);
  a.use((req, _res, next) => {
    const id = req.get('x-store-id');
    if (id && KNOWN.has(id)) setResolvedStoreId(req, id);
    next();
  });
  a.use(createStoreMissLimiter({ skip: never, max: MAX, store }));
  const answer = (req: express.Request, res: express.Response) =>
    req.params.slug === 'live' ? res.json({ ok: true }) : res.status(404).json({ ok: false });
  a.get('/products/:slug', catalogueMissRoute('GET /public/products/:slugOrId'), answer);
  a.get('/:storeId/blog/:slug', catalogueMissRoute('GET /public/:storeId/blog/:slug'), answer);
  a.get('/:storeId/locations/:slug', answer); // a store route that is NOT on the list
  return (path: string, ip: string, storeHeader?: string) => {
    const r = request(a).get(path).set('x-forwarded-for', ip);
    return storeHeader ? r.set('x-store-id', storeHeader) : r;
  };
}

/** The count is written after the response: wait for it, then give a wrong extra write time to show up. */
async function settled(writes: string[], n: number) {
  await vi.waitFor(() => expect(writes.length).toBeGreaterThanOrEqual(n));
  await new Promise(r => setTimeout(r, 25));
  expect(writes).toHaveLength(n);
}

describe('store-miss limiter: a dead catalogue link inside a verified store is not a miss', () => {
  it('dead product links on a verified store: all 404, nothing written, never refused', async () => {
    const { store, writes } = counterStore();
    const get = app(store);
    for (let i = 0; i < MAX * 4; i++) {
      const res = await get(`/products/dead-${i}`, '9.3.0.1', STORE_A);
      expect(res.status).toBe(404);
      expect(res.headers['ratelimit-remaining']).toBe(String(MAX));
    }
    await settled(writes, 0);
  });

  it('dead blog links on a verified store whose id is the path id: nothing written', async () => {
    const { store, writes } = counterStore();
    const get = app(store);
    for (let i = 0; i < MAX * 4; i++) {
      expect((await get(`/${STORE_A}/blog/dead-${i}`, '9.3.0.2', STORE_A)).status).toBe(404);
    }
    await settled(writes, 0);
  });

  it('condition 1, the verified-store flag: the same product route with no verified store is counted and refused', async () => {
    const { store, writes } = counterStore();
    const get = app(store);
    const ip = '9.3.0.3';
    for (let i = 0; i < MAX; i++) {
      expect((await get(`/products/dead-${i}`, ip, UNKNOWN)).status).toBe(404);
      await settled(writes, i + 1);
    }
    expect((await get('/products/dead-x', ip, UNKNOWN)).status).toBe(429);
    // no store named at all is no proof either
    expect((await get('/products/dead-y', '9.3.0.4')).status).toBe(404);
    await settled(writes, MAX + 1);
  });

  it('condition 2, the list: a 404 from a route that is not listed is counted on a verified store', async () => {
    const { store, writes } = counterStore();
    const get = app(store);
    const ip = '9.3.0.5';
    for (let i = 0; i < MAX; i++) {
      expect((await get(`/${STORE_A}/locations/dead-${i}`, ip, STORE_A)).status).toBe(404);
      await settled(writes, i + 1);
    }
    expect((await get(`/${STORE_A}/locations/dead-x`, ip, STORE_A)).status).toBe(429);
  });

  it('condition 3, the same store: a blog path id that is not the verified id is counted', async () => {
    const { store, writes } = counterStore();
    const get = app(store);
    const ip = '9.3.0.6';
    // verified A, path B (a real store) and path unknown: both counted
    expect((await get(`/${STORE_B}/blog/dead`, ip, STORE_A)).status).toBe(404);
    await settled(writes, 1);
    expect((await get(`/${UNKNOWN}/blog/dead`, ip, STORE_A)).status).toBe(404);
    await settled(writes, 2);
    // the control: same caller, same route, path id = verified id
    expect((await get(`/${STORE_A}/blog/dead`, ip, STORE_A)).status).toBe(404);
    await settled(writes, 2);
  });

  it('a blog path id alone (no verified store) is counted, even for a store that exists', async () => {
    const { store, writes } = counterStore();
    const get = app(store);
    expect((await get(`/${STORE_A}/blog/dead`, '9.3.0.7')).status).toBe(404);
    await settled(writes, 1);
  });

  it('an unmatched route and a 200 behave as before: the 404 is counted, the 200 writes nothing', async () => {
    const { store, writes } = counterStore();
    const get = app(store);
    expect((await get('/nothing-here', '9.3.0.8', STORE_A)).status).toBe(404);
    await settled(writes, 1);
    expect((await get('/products/live', '9.3.0.8', STORE_A)).status).toBe(200);
    expect((await get(`/${STORE_A}/blog/live`, '9.3.0.8', STORE_A)).status).toBe(200);
    await settled(writes, 1);
  });

  it('an IP already refused stays refused on the exempt routes (the exemption never lifts the limit)', async () => {
    const { store, writes } = counterStore();
    const get = app(store);
    const ip = '9.3.0.9';
    for (let i = 0; i < MAX; i++) {
      expect((await get(`/nothing-${i}`, ip)).status).toBe(404);
      await settled(writes, i + 1);
    }
    const res = await get('/products/dead', ip, STORE_A);
    expect(res.status).toBe(429);
    expect(res.body).toEqual({
      success: false,
      error: { code: 'RATE_LIMITED', message: 'Too many requests, please slow down.' },
    });
  });
});

describe('store-miss limiter: where the exemption is wired', () => {
  const root = join(__dirname, '../..');
  const routesDir = join(root, 'apps/api/src/routes');
  const read = (p: string) => readFileSync(join(root, p), 'utf8');

  it('the list is exactly product-by-slug-or-id and blog-post-by-slug', () => {
    expect([...CATALOGUE_MISS_ROUTES]).toEqual([
      'GET /public/products/:slugOrId',
      'GET /public/:storeId/blog/:slug',
    ]);
  });

  it('the marker is on exactly those two routes and nowhere else in the routers', () => {
    const uses: string[] = [];
    for (const f of readdirSync(routesDir, { recursive: true }) as string[]) {
      if (!f.endsWith('.ts')) continue;
      const src = readFileSync(join(routesDir, f), 'utf8');
      for (const m of src.matchAll(/catalogueMissRoute\(\s*'([^']+)'\s*\)/g))
        uses.push(`${f}: ${m[1]}`);
      // every call is a literal the pattern above saw
      expect(src.split('catalogueMissRoute(').length - 1, f).toBe(
        [...src.matchAll(/catalogueMissRoute\(\s*'[^']+'\s*\)/g)].length
      );
    }
    expect(uses.sort()).toEqual([
      'blog.routes.ts: GET /public/:storeId/blog/:slug',
      'public.routes.ts: GET /public/products/:slugOrId',
    ]);
    // on the route it names, in front of the handler
    expect(read('apps/api/src/routes/public.routes.ts')).toContain(
      "router.get('/products/:slugOrId', catalogueMissRoute('GET /public/products/:slugOrId'));\n" +
        "router.get('/products/:slugOrId', async (req"
    );
    expect(read('apps/api/src/routes/blog.routes.ts')).toMatch(
      /router\.get\(\s*'\/public\/:storeId\/blog\/:slug',\s*catalogueMissRoute\('GET \/public\/:storeId\/blog\/:slug'\),\s*async \(req/
    );
  });

  it('the limiter asks only after it saw a 404, and nothing else in the API can lift a count', () => {
    const src = read('apps/api/src/middleware/security.ts');
    expect(src).toContain(
      'if (res.statusCode !== 404) return;\n' +
        '      // LAUNCH-RL-MISS-3: a dead product or blog link inside a store the resolver verified is not store probing\n' +
        '      if (isVerifiedCatalogueMiss(req, res)) return;'
    );
    expect(src.split('isVerifiedCatalogueMiss(').length - 1).toBe(1);
  });

  it('only the store resolver sets the verified-store flag', () => {
    const setters: string[] = [];
    const walk = (dir: string) => {
      for (const f of readdirSync(dir, { recursive: true }) as string[]) {
        if (!f.endsWith('.ts')) continue;
        if (readFileSync(join(dir, f), 'utf8').includes('setResolvedStoreId(')) setters.push(f);
      }
    };
    walk(join(root, 'apps/api/src'));
    expect(setters.sort()).toEqual(['utils/resolved-store.ts', 'utils/store-helpers.ts']);
  });
});
