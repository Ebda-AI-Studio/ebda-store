/**
 * Size charts (B0 Task 9), through the real routes and the real auth chain
 * (authenticate -> authorize -> requireStoreAccess), each request bound to the guarded app
 * client on the strict-RLS role `ebda_app` — so both tenant layers (R-EBDA-001 RLS and the
 * R-EBDA-003 code guard) are exercised, as in production.
 *
 *  - CRUD + tenant isolation: another store's admin gets 404 on the chart by id and 403 on the
 *    store's chart list; a ragged chart is a 400.
 *  - Linking: a product or category cannot point at another store's chart.
 *  - PDP: `sizeChart` = the product's chart, else its category's, else null; the nested
 *    per-category chart is not repeated in the payload; a chart write busts the cached PDP.
 *  - Review focus #6: deleting a chart that products and categories still point to is a 200,
 *    the FK SET NULLs both, and the PDP drops the guide without a 500.
 *  - Deleting a product, a category or the whole store never trips an FK on size_charts.
 *
 * Retry-safe: every store, user and slug is per CALL unique.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import crypto from 'crypto';
import express, { type Express, type Request, type Response, type NextFunction } from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { prisma, createPrismaClient, runWithRequestDb } from '@ebda/database';
import { awaitDeferredWork } from '@api/lib/after-tenant-commit';
import sizeChartRoutes from '@api/routes/size-chart.routes';
import productRoutes from '@api/routes/product.routes';
import categoryRoutes from '@api/routes/category.routes';
import publicRoutes from '@api/routes/public.routes';
import { tenantContext, publicStoreContext } from '@api/middleware/tenant-context';
import { errorHandler } from '@api/middleware/error-handler';
import { sanitizeInput } from '@api/middleware/security';
import { config } from '@api/config';
import { hasDb } from '../helpers/bundle-fixtures';

const OWNER_URL = process.env.DIRECT_URL || process.env.DATABASE_URL || '';
function appUrl(): string {
  const u = new URL(OWNER_URL);
  u.username = 'ebda_app';
  u.password = process.env.EBDA_APP_PASSWORD || 'ci-only-app-pw';
  return u.toString();
}
const asApp = <T>(fn: () => Promise<T>) =>
  runWithRequestDb(() => createPrismaClient({ connectionString: appUrl(), max: 3 }), fn, {
    beforeDisconnect: () => awaitDeferredWork(5000),
  });

function buildApp(): Express {
  const app = express();
  app.use(express.json());
  // The global body sanitizer (app.ts) runs before every route; it used to turn `rows`
  // (string[][]) into objects, so the chart routes must be proven behind it.
  app.use(sanitizeInput);
  app.use((req: Request, res: Response, next: NextFunction) => {
    asApp(
      () =>
        new Promise<void>(resolve => {
          res.once('finish', resolve);
          res.once('close', resolve);
          next();
        })
    ).catch(next);
  });
  // Mounted exactly as apps/api/src/routes/index.ts mounts them.
  app.use('/api/v1/public', publicStoreContext);
  app.use('/api/v1/public', publicRoutes);
  app.use('/api/v1/stores/:storeId/products', tenantContext, productRoutes);
  app.use('/api/v1/stores/:storeId/categories', tenantContext, categoryRoutes);
  app.use('/api/v1/stores/:storeId/size-charts', tenantContext, sizeChartRoutes);
  app.use(errorHandler);
  return app;
}

const created = { storeIds: [] as string[], userIds: [] as string[] };
const uid = () => crypto.randomUUID().slice(0, 12);

async function seedStore(tag: string) {
  const id = uid();
  const owner = await prisma.user.create({
    data: {
      email: `size-chart-${tag}-${id}@test.local`,
      passwordHash: 'x',
      firstName: 'Size',
      lastName: 'Chart',
      role: 'store_admin',
      status: 'active',
      emailVerified: true,
    },
  });
  created.userIds.push(owner.id);
  const store = await prisma.store.create({
    data: {
      name: `Size Chart ${tag} ${id}`,
      slug: `size-chart-${tag}-${id}`,
      ownerId: owner.id,
      status: 'active',
      currency: 'EGP',
    },
  });
  created.storeIds.push(store.id);
  const token = jwt.sign(
    { userId: owner.id, email: owner.email, role: 'store_admin', tv: 0 },
    config.jwtSecret,
    { expiresIn: '10m', issuer: 'force-api', audience: 'force-app' }
  );
  return { storeId: store.id, token };
}

const abaya = {
  name: '',
  nameAr: 'عباية',
  unit: 'cm',
  columns: [
    { label: 'Size', labelAr: 'المقاس' },
    { label: '', labelAr: 'الطول' },
    { label: 'Bust', labelAr: 'الصدر' },
  ],
  rows: [
    ['S', '52', '90'],
    ['M', '54', '96'],
    ['L', '56', '102'],
  ],
  note: '',
  noteAr: 'القياسات بالسنتيمتر',
};

afterAll(async () => {
  if (!hasDb) return;
  const storeIds = created.storeIds;
  await prisma.auditLog.deleteMany({ where: { userId: { in: created.userIds } } });
  await prisma.product.deleteMany({ where: { storeId: { in: storeIds } } });
  await prisma.category.deleteMany({ where: { storeId: { in: storeIds } } });
  await prisma.sizeChart.deleteMany({ where: { storeId: { in: storeIds } } });
  await prisma.store.deleteMany({ where: { id: { in: storeIds } } });
  await prisma.user.deleteMany({ where: { id: { in: created.userIds } } });
});

describe.skipIf(!hasDb)('size charts (B0 Task 9) under the tenant guard + strict RLS', () => {
  let app: Express;
  let A: { storeId: string; token: string };
  let B: { storeId: string; token: string };
  const api = () => request(app);
  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
  const pdp = (storeId: string, slug: string) =>
    api().get(`/api/v1/public/products/${slug}`).set('x-store-id', storeId);

  async function product(storeId: string, token: string, extra: object = {}) {
    const res = await api()
      .post(`/api/v1/stores/${storeId}/products`)
      .set(auth(token))
      .send({ name: `Linen Abaya ${uid()}`, price: 5000, status: 'active', ...extra });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body.data.product as { id: string; slug: string };
  }

  beforeAll(async () => {
    app = buildApp();
    A = await seedStore('a');
    B = await seedStore('b');
  });

  it('crud + tenant isolation', async () => {
    const c = await api()
      .post(`/api/v1/stores/${A.storeId}/size-charts`)
      .set(auth(A.token))
      .send(abaya);
    expect(c.status, JSON.stringify(c.body)).toBe(201);
    const id = c.body.data.id as string;
    expect(c.body.data.rows).toEqual(abaya.rows);

    const list = await api().get(`/api/v1/stores/${A.storeId}/size-charts`).set(auth(A.token));
    expect(list.status).toBe(200);
    expect(list.body.data.sizeCharts.map((s: { id: string }) => s.id)).toContain(id);

    const put = await api()
      .put(`/api/v1/stores/${A.storeId}/size-charts/${id}`)
      .set(auth(A.token))
      .send({ ...abaya, unit: 'in' });
    expect(put.status).toBe(200);
    expect(put.body.data.unit).toBe('in');

    // Store B's admin, in store B's scope, cannot see, edit or delete A's chart by id.
    for (const method of ['get', 'put', 'delete'] as const) {
      const r = await api()
        [method](`/api/v1/stores/${B.storeId}/size-charts/${id}`)
        .set(auth(B.token))
        .send(abaya);
      expect(r.status, `${method} ${JSON.stringify(r.body)}`).toBe(404);
    }
    // ...and cannot enter store A's scope at all.
    expect(
      (await api().get(`/api/v1/stores/${A.storeId}/size-charts`).set(auth(B.token))).status
    ).toBe(403);
    // No auth -> 401.
    expect((await api().get(`/api/v1/stores/${A.storeId}/size-charts`)).status).toBe(401);
    // The row survived B's attempts.
    expect(await prisma.sizeChart.count({ where: { id } })).toBe(1);
  });

  it('rejects a ragged chart and an unknown unit (400)', async () => {
    for (const bad of [
      { ...abaya, rows: [['S', '52']] },
      { ...abaya, unit: 'mm' },
      { ...abaya, name: '', nameAr: '' },
    ]) {
      const r = await api()
        .post(`/api/v1/stores/${A.storeId}/size-charts`)
        .set(auth(A.token))
        .send(bad);
      expect(r.status).toBe(400);
    }
  });

  it("a product or category cannot link another store's chart", async () => {
    const bChart = await api()
      .post(`/api/v1/stores/${B.storeId}/size-charts`)
      .set(auth(B.token))
      .send(abaya);
    expect(bChart.status).toBe(201);
    const p = await product(A.storeId, A.token);
    const r = await api()
      .put(`/api/v1/stores/${A.storeId}/products/${p.id}`)
      .set(auth(A.token))
      .send({ sizeChartId: bChart.body.data.id });
    expect(r.status).toBe(404);
    expect(r.body.error.code).toBe('SIZE_CHART_NOT_FOUND');
    const cat = await api()
      .post(`/api/v1/stores/${A.storeId}/categories`)
      .set(auth(A.token))
      .send({ name: `Abayas ${uid()}`, sizeChartId: bChart.body.data.id });
    expect(cat.status).toBe(404);
  });

  it('pdp resolves product chart, else category chart; deleting a chart nulls references', async () => {
    const mk = async (nameAr: string) => {
      const r = await api()
        .post(`/api/v1/stores/${A.storeId}/size-charts`)
        .set(auth(A.token))
        .send({ ...abaya, nameAr });
      expect(r.status).toBe(201);
      return r.body.data.id as string;
    };
    const catChart = await mk('جدول القسم');
    const ownChart = await mk('جدول المنتج');

    const cat = await api()
      .post(`/api/v1/stores/${A.storeId}/categories`)
      .set(auth(A.token))
      .send({ name: `Abayas ${uid()}` });
    expect(cat.status).toBe(201);
    const categoryId = cat.body.data.category.id as string;
    const p = await product(A.storeId, A.token, { categories: [categoryId] });

    // No chart anywhere -> null (and the cached payload is primed).
    let r = await pdp(A.storeId, p.slug);
    expect(r.status).toBe(200);
    expect(r.body.data.product.sizeChart).toBeNull();

    // Category chart -> inherited. The category write busts the cached PDP.
    const linkCat = await api()
      .put(`/api/v1/stores/${A.storeId}/categories/${categoryId}`)
      .set(auth(A.token))
      .send({ sizeChartId: catChart });
    expect(linkCat.status).toBe(200);
    r = await pdp(A.storeId, p.slug);
    expect(r.body.data.product.sizeChart.id).toBe(catChart);
    expect(r.body.data.product.sizeChart.nameAr).toBe('جدول القسم');
    expect(r.body.data.product.sizeChart.rows).toEqual(abaya.rows);
    // The category's chart is not repeated inside `categories`.
    expect(r.body.data.product.categories[0].category).not.toHaveProperty('sizeChart');

    // Product chart wins.
    const own = await api()
      .put(`/api/v1/stores/${A.storeId}/products/${p.id}`)
      .set(auth(A.token))
      .send({ sizeChartId: ownChart });
    expect(own.status).toBe(200);
    r = await pdp(A.storeId, p.slug);
    expect(r.body.data.product.sizeChart.id).toBe(ownChart);

    // A chart edit reaches the cached PDP.
    const edit = await api()
      .put(`/api/v1/stores/${A.storeId}/size-charts/${ownChart}`)
      .set(auth(A.token))
      .send({ ...abaya, nameAr: 'جدول معدل' });
    expect(edit.status).toBe(200);
    r = await pdp(A.storeId, p.slug);
    expect(r.body.data.product.sizeChart.nameAr).toBe('جدول معدل');

    // Delete the product's chart -> FK SET NULL, PDP falls back to the category chart.
    const del1 = await api()
      .delete(`/api/v1/stores/${A.storeId}/size-charts/${ownChart}`)
      .set(auth(A.token));
    expect(del1.status).toBe(200);
    expect((await prisma.product.findUnique({ where: { id: p.id } }))?.sizeChartId).toBeNull();
    r = await pdp(A.storeId, p.slug);
    expect(r.status).toBe(200);
    expect(r.body.data.product.sizeChart.id).toBe(catChart);

    // Delete the category's chart -> category nulled, PDP has no guide, no 500.
    const del2 = await api()
      .delete(`/api/v1/stores/${A.storeId}/size-charts/${catChart}`)
      .set(auth(A.token));
    expect(del2.status).toBe(200);
    expect(
      (await prisma.category.findUnique({ where: { id: categoryId } }))?.sizeChartId
    ).toBeNull();
    r = await pdp(A.storeId, p.slug);
    expect(r.status).toBe(200);
    expect(r.body.data.product.sizeChart).toBeNull();

    // Product edit page: `null` clears an own chart, omitting the key leaves it.
    const again = await mk('جدول تالت');
    await api()
      .put(`/api/v1/stores/${A.storeId}/products/${p.id}`)
      .set(auth(A.token))
      .send({ sizeChartId: again });
    await api()
      .put(`/api/v1/stores/${A.storeId}/products/${p.id}`)
      .set(auth(A.token))
      .send({ name: 'Renamed' });
    expect((await prisma.product.findUnique({ where: { id: p.id } }))?.sizeChartId).toBe(again);
    await api()
      .put(`/api/v1/stores/${A.storeId}/products/${p.id}`)
      .set(auth(A.token))
      .send({ sizeChartId: null });
    expect((await prisma.product.findUnique({ where: { id: p.id } }))?.sizeChartId).toBeNull();
  });

  it("GET /public/size-charts lists only the resolved store's charts", async () => {
    const r = await api().get('/api/v1/public/size-charts').set('x-store-id', A.storeId);
    expect(r.status).toBe(200);
    const ids: string[] = r.body.data.sizeCharts.map((c: { id: string }) => c.id);
    expect(ids.length).toBeGreaterThan(0);
    const own = await prisma.sizeChart.findMany({
      where: { storeId: A.storeId },
      select: { id: true },
    });
    expect(new Set(ids)).toEqual(new Set(own.map(o => o.id)));
    // A store with charts of its own sees none of A's.
    const rb = await api().get('/api/v1/public/size-charts').set('x-store-id', B.storeId);
    expect(rb.body.data.sizeCharts.every((c: { id: string }) => !ids.includes(c.id))).toBe(true);
  });

  it('deleting a product, a category or the whole store never trips an FK on size_charts', async () => {
    const C = await seedStore('c');
    const chart = await prisma.sizeChart.create({
      data: { storeId: C.storeId, nameAr: 'عباية', columns: abaya.columns, rows: abaya.rows },
    });
    const mkCat = () =>
      prisma.category.create({
        data: {
          storeId: C.storeId,
          name: `Cat ${uid()}`,
          slug: `cat-${uid()}`,
          sizeChartId: chart.id,
        },
      });
    const mkProd = () =>
      prisma.product.create({
        data: {
          storeId: C.storeId,
          name: 'P',
          slug: `p-${uid()}`,
          price: 100,
          sizeChartId: chart.id,
        },
      });
    // Hard deletes of the referencing rows (bulk permanent delete / import rollback paths).
    const p1 = await mkProd();
    const c1 = await mkCat();
    await prisma.product.deleteMany({ where: { id: p1.id, storeId: C.storeId } });
    await prisma.category.deleteMany({ where: { id: c1.id, storeId: C.storeId } });
    expect(await prisma.sizeChart.count({ where: { id: chart.id } })).toBe(1);
    // Whole-store delete with live references (StoreService.delete ends in this statement).
    await mkProd();
    await mkCat();
    await prisma.$executeRaw`DELETE FROM public.stores WHERE id = ${C.storeId}`;
    expect(await prisma.sizeChart.count({ where: { storeId: C.storeId } })).toBe(0);
    expect(await prisma.product.count({ where: { storeId: C.storeId } })).toBe(0);
  });
});
