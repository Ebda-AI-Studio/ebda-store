/**
 * Ruling LAZY-TX-1: a cached public catalogue read (`GET /public/categories`, `/public/tags`,
 * anonymous, no query) opens NO per-request tenant transaction and NO tenant scope, run the way
 * production runs it: a guarded app client on the strict-RLS role `ebda_app` bound per request.
 *
 * Proved here, on a real database:
 *  1. the request reaches the handler with NO ambient scope (no transaction was opened);
 *  2. a cache MISS still returns the store's data, through the handler's own short scoped read
 *     (so RLS is satisfied, not bypassed), and a cache HIT issues ZERO database queries;
 *  3. it fails CLOSED: any DB access on that path that is not inside a scope THROWS
 *     (TenantScopeViolation), for a model query and for raw SQL naming a tenant table;
 *  4. isolation: another store's host gets only its own categories;
 *  5. everything else keeps the request transaction: authenticated/cookie-bearing requests, a
 *     query-carrying request, and other routes see the store scope as before.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import crypto from 'node:crypto';
import express, { type Express, type Request, type Response, type NextFunction } from 'express';
import request from 'supertest';
import {
  createPrismaClient,
  runWithRequestDb,
  currentTenantGucs,
  setDbHopObserver,
  prisma,
  TenantScopeViolation,
  type AppPrismaClient,
} from '@ebda/database';
import publicRoutes from '@api/routes/public.routes';
import { publicStoreContext } from '@api/middleware/tenant-context';
import { errorHandler } from '@api/middleware/error-handler';
import { awaitDeferredWork } from '@api/lib/after-tenant-commit';
import { hasDb } from '../helpers/bundle-fixtures';
import { setAppRoleLogin } from '../helpers/app-role-login';

const OWNER_URL = process.env.DIRECT_URL || process.env.DATABASE_URL || '';
const PREFIX = 'lazytx-';
const appUrl = () => {
  const u = new URL(OWNER_URL);
  u.username = 'ebda_app';
  u.password = process.env.EBDA_APP_PASSWORD || 'ci-only-app-pw';
  return u.toString();
};

describe.skipIf(!hasDb)('cached public reads open no request transaction (ebda_app)', () => {
  let owner: AppPrismaClient;
  let app: Express;
  const ids = {} as { a: string; b: string; run: string };
  const seen: Array<{ path: string; scope: string | undefined }> = [];
  const forced: { err?: unknown; rawErr?: unknown } = {};
  const dbLabels: string[] = [];
  let tracing = false;

  async function cleanup() {
    await owner.$executeRawUnsafe(
      `DELETE FROM public.products WHERE store_id IN (SELECT id FROM public.stores WHERE slug LIKE '${PREFIX}%')`
    );
    await owner.$executeRawUnsafe(
      `DELETE FROM public.categories WHERE store_id IN (SELECT id FROM public.stores WHERE slug LIKE '${PREFIX}%')`
    );
    await owner.$executeRawUnsafe(`DELETE FROM public.stores WHERE slug LIKE '${PREFIX}%'`);
    await owner.$executeRawUnsafe(`DELETE FROM public.users WHERE email LIKE '${PREFIX}%'`);
  }

  beforeAll(async () => {
    owner = createPrismaClient({ connectionString: OWNER_URL, max: 3, role: 'owner' });
    await setAppRoleLogin(owner, process.env.EBDA_APP_PASSWORD || 'ci-only-app-pw');
    await cleanup();
    const run = crypto.randomUUID().slice(0, 8);
    const mk = async (tag: string) => {
      const u = await owner.user.create({
        data: {
          email: `${PREFIX}${tag}-${run}@test.com`,
          passwordHash: 'x',
          firstName: tag,
          lastName: 'T',
          role: 'store_admin' as never,
        },
      });
      const s = await owner.store.create({
        data: { slug: `${PREFIX}${tag}-${run}`, name: `LT ${tag}`, ownerId: u.id },
      });
      const cat = await owner.category.create({
        data: { storeId: s.id, name: `cat-${tag}`, slug: `cat-${tag}-${run}` },
      });
      // QA-B2: shoppers only see a category that holds a visible product, so the fixture links one.
      await owner.product.create({
        data: {
          storeId: s.id,
          name: `prod-${tag}`,
          slug: `prod-${tag}-${run}`,
          price: 1000,
          status: 'active' as never,
          categories: { create: [{ categoryId: cat.id }] },
        },
      });
      // ...and an empty one that must stay hidden.
      await owner.category.create({
        data: { storeId: s.id, name: `empty-${tag}`, slug: `empty-${tag}-${run}` },
      });
      return s.id;
    };
    ids.run = run;
    ids.a = await mk('a');
    ids.b = await mk('b');

    app = express();
    app.use((_req: Request, res: Response, next: NextFunction) => {
      runWithRequestDb(
        () => createPrismaClient({ connectionString: appUrl(), max: 3 }),
        () =>
          new Promise<void>(resolve => {
            res.once('finish', resolve);
            res.once('close', resolve);
            next();
          }),
        { beforeDisconnect: () => awaitDeferredWork(5000) }
      ).catch(next);
    });
    setDbHopObserver((label: string) => {
      if (tracing) dbLabels.push(label);
    });
    app.use('/api/v1/public', publicStoreContext);
    // Probe: what scope is ambient AFTER publicStoreContext, BEFORE the real handlers?
    app.use('/api/v1/public', (req: Request, _res: Response, next: NextFunction) => {
      seen.push({ path: req.path, scope: currentTenantGucs()?.storeId });
      next();
    });
    // Forced DB access ON the lazy path: for a real GET /categories carrying x-force-db, run an
    // unscoped model query and an unscoped raw query naming a tenant table, record what happened.
    app.use('/api/v1/public', async (req: Request, _res: Response, next: NextFunction) => {
      if (req.headers['x-force-db'] !== '1') return next();
      forced.err = await prisma.product.findMany().then(
        () => undefined,
        (e: unknown) => e
      );
      forced.rawErr = await prisma.$queryRawUnsafe('SELECT id FROM public.products LIMIT 1').then(
        () => undefined,
        (e: unknown) => e
      );
      next();
    });
    app.use('/api/v1/public', publicRoutes);
    app.use(errorHandler);
  });

  afterAll(async () => {
    setDbHopObserver(undefined);
    await cleanup();
    await owner.$disconnect();
  });

  const get = (path: string, storeId: string) =>
    request(app).get(`/api/v1/public${path}`).set('x-store-id', storeId);

  it('a cache MISS returns the store data through the handler own scoped read, with no ambient scope on arrival', async () => {
    seen.length = 0;
    const r = await get('/categories', ids.a);
    expect(r.status).toBe(200);
    const cats = r.body.data.categories as Array<{ name: string }>;
    expect(cats.map(c => c.name)).toContain('cat-a');
    expect(cats.map(c => c.name)).not.toContain('empty-a');
    expect(seen.at(-1)).toMatchObject({ path: '/categories', scope: undefined });
  });

  it('a cache HIT issues ZERO database queries and still opens no scope', async () => {
    await get('/categories', ids.a); // warm
    seen.length = 0;
    dbLabels.length = 0;
    tracing = true;
    const r = await get('/categories', ids.a);
    tracing = false;
    expect(r.status).toBe(200);
    expect(r.body.data.categories.map((c: { name: string }) => c.name)).toContain('cat-a');
    // The only queries allowed are the store-id lookup definer(s) (raw, no tenant table).
    expect(dbLabels.filter(l => l !== 'db-raw')).toEqual([]);
    expect(seen.at(-1)?.scope).toBeUndefined();
  });

  it('/tags (no query) also arrives with no ambient scope and returns 200', async () => {
    seen.length = 0;
    const r = await get('/tags', ids.a);
    expect(r.status).toBe(200);
    expect(seen.at(-1)).toMatchObject({ path: '/tags', scope: undefined });
  });

  it('FAILS CLOSED: a DB access on the lazy path that is not inside a scope throws', async () => {
    forced.err = forced.rawErr = undefined;
    const r = await get('/categories', ids.a).set('x-force-db', '1');
    expect(r.status).toBe(200);
    expect(forced.err, 'model query without a scope must throw').toBeInstanceOf(
      TenantScopeViolation
    );
    expect(
      forced.rawErr,
      'raw SQL naming a tenant table without a scope must throw'
    ).toBeInstanceOf(TenantScopeViolation);
  });

  it('isolation: another store gets only its own categories', async () => {
    const a = await get('/categories', ids.a);
    const b = await get('/categories', ids.b);
    const names = (x: request.Response) =>
      x.body.data.categories.map((c: { name: string }) => c.name);
    expect(names(a)).toContain('cat-a');
    expect(names(a)).not.toContain('cat-b');
    expect(names(b)).toContain('cat-b');
    expect(names(b)).not.toContain('cat-a');
  });

  describe('the anonymous product list and the product page (extended pattern)', () => {
    it('the list arrives with no ambient scope, a miss returns the store products only', async () => {
      seen.length = 0;
      const r = await get('/products', ids.a);
      expect(r.status).toBe(200);
      const names = JSON.stringify(r.body);
      expect(names).toContain('prod-a');
      expect(names).not.toContain('prod-b');
      expect(seen.at(-1)).toMatchObject({ path: '/products', scope: undefined });
    });

    it('a list HIT makes no product/category/store queries (only the store-id definer and the feature read)', async () => {
      await get('/products?page=1&limit=10', ids.a); // warm
      dbLabels.length = 0;
      tracing = true;
      const r = await get('/products?page=1&limit=10', ids.a);
      tracing = false;
      expect(r.status).toBe(200);
      const tenantQueries = dbLabels.filter(
        l =>
          /^db-(Product|Category|Store|ProductVariant|ProductOption)\b/.test(l) &&
          !/^db-Store(Feature)?\./.test(l)
      );
      expect(tenantQueries).toEqual([]);
      expect(seen.at(-1)?.scope).toBeUndefined();
    });

    it('the product page arrives with no ambient scope and returns the product', async () => {
      seen.length = 0;
      const r = await get(`/products/prod-a-${ids.run}`, ids.a);
      expect(r.status).toBe(200);
      expect(JSON.stringify(r.body)).toContain('prod-a');
      expect(seen.at(-1)).toMatchObject({ scope: undefined });
    });

    it('another store cannot read this store product page (404, never the product)', async () => {
      const r = await get(`/products/prod-a-${ids.run}`, ids.b);
      expect(JSON.stringify(r.body)).not.toContain('prod-a');
    });

    it('FAILS CLOSED on both routes: an unscoped model query and raw SQL throw', async () => {
      for (const path of ['/products', `/products/prod-a-${ids.run}`]) {
        forced.err = forced.rawErr = undefined;
        await get(path, ids.a).set('x-force-db', '1');
        expect(forced.err, `${path}: model query`).toBeInstanceOf(TenantScopeViolation);
        expect(forced.rawErr, `${path}: raw query`).toBeInstanceOf(TenantScopeViolation);
      }
    });

    it.each([
      ['a search term', '/products?search=prod'],
      ['a category filter', '/products?category=x'],
      ['a tag filter', '/products?tag=x'],
      ['an ids filter', '/products?ids=a'],
      ['an unknown query key', '/products?x=1'],
      ['a query on the product page', '/products/p?x=1'],
    ])('%s keeps the request transaction (store scope ambient)', async (_n, path) => {
      seen.length = 0;
      await get(path, ids.a);
      expect(seen.at(-1)?.scope).toBe(ids.a);
    });
  });

  it.each([
    ['a request with a cookie', (s: string) => get('/categories', s).set('Cookie', 'x=1')],
    [
      'a request with Authorization',
      (s: string) => get('/categories', s).set('Authorization', 'Bearer nope'),
    ],
    ['a request carrying a query', (s: string) => get('/categories?x=1', s)],
    ['another route (/size-charts)', (s: string) => get('/size-charts', s)],
  ])('%s keeps the request transaction (store scope ambient)', async (_n, call) => {
    seen.length = 0;
    await call(ids.a);
    const last = seen.at(-1);
    expect(last?.scope).toBe(ids.a);
  });
});
