/**
 * M-107: ReorderRule had a reader (reorder-scan, low-stock report) and NO writer, so the report had no data. These drive
 * the real routes + zod + service over an in-memory two-store fake of storeDb/storeWriter (the same seam the DO path uses),
 * so isolation is proven by the `storeId` the service puts in every where, not by the mocks.
 */
import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest';
import express, { type Express } from 'express';
import request from 'supertest';

type Row = Record<string, any>;
const { tables, audit } = vi.hoisted(() => ({
  tables: {} as Record<string, Row[]>,
  audit: [] as Array<Record<string, any>>,
}));

function match(row: Row, where: Row): boolean {
  return Object.entries(where).every(([k, v]) => (row[k] ?? null) === (v ?? null));
}
function delegate(name: string) {
  const rows = () => (tables[name] ??= []);
  return {
    findFirst: async ({ where, include }: any) => {
      const r = rows().find(x => match(x, where));
      if (!r) return null;
      if (name === 'reorderRule' && include) {
        return {
          ...r,
          product: tables.product.find(p => p.id === r.productId) ?? null,
          variant: tables.productVariant.find(v => v.id === r.variantId) ?? null,
          preferredSupplier: tables.supplier.find(s => s.id === r.preferredSupplierId) ?? null,
        };
      }
      return r;
    },
    findMany: async ({ where }: any) => rows().filter(x => match(x, where)),
    create: async ({ data }: any) => {
      const r = { id: crypto.randomUUID(), ...data };
      rows().push(r);
      return r;
    },
    update: async ({ where, data }: any) => {
      const r = rows().find(x => match(x, where))!;
      Object.assign(r, data);
      return r;
    },
    delete: async ({ where }: any) => {
      const i = rows().findIndex(x => match(x, where));
      if (i >= 0) rows().splice(i, 1);
    },
  };
}
const fake = new Proxy({}, { get: (_t, k: string) => delegate(k) });

vi.mock('@api/lib/repo-factory', () => ({
  storeDb: async (id: string) => {
    if (!id) throw new Error('unresolved store');
    return fake;
  },
  storeWriter: async (id: string) => {
    if (!id) throw new Error('unresolved store');
    return fake;
  },
}));
vi.mock('@api/lib/jobs/store-db', () => ({
  runInStoreCtx: (_s: string, fn: () => unknown) => fn(),
}));
vi.mock('@api/middleware/auth', () => ({
  authenticate: (req: any, _res: any, next: any) => {
    req.user = { userId: 'u-1', role: 'store_admin' };
    next();
  },
  authorize: () => (_req: any, _res: any, next: any) => next(),
}));
vi.mock('@api/middleware/require-mfa', () => ({
  requireMfaEnrolled: (_q: any, _s: any, n: any) => n(),
}));
vi.mock('@api/middleware/store-access', () => ({
  requireStoreAccess: (_q: any, _s: any, n: any) => n(),
}));
vi.mock('@api/middleware/security', () => ({
  writeLimiter: (_q: any, _s: any, n: any) => n(),
  auditLog: async (e: any) => {
    audit.push(e);
  },
}));

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const PA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const PB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const VA = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const SB = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

let app: Express;
beforeAll(async () => {
  const { default: router } = await import('@api/routes/reorder-rules.routes');
  const { errorHandler } = await import('@api/middleware/error-handler');
  app = express();
  app.use(express.json());
  app.use('/stores', router);
  app.use(errorHandler);
});
beforeEach(() => {
  audit.length = 0;
  for (const k of Object.keys(tables)) delete tables[k];
  tables.product = [
    { id: PA, storeId: A, name: 'Tee', nameAr: null, sku: 'T-1', deletedAt: null },
    { id: PB, storeId: B, name: 'Other', nameAr: null, sku: 'O-1', deletedAt: null },
  ];
  tables.productVariant = [{ id: VA, productId: PA, title: 'L', titleAr: null, sku: 'T-1-L' }];
  tables.supplier = [{ id: SB, storeId: B, name: 'B supplier', deletedAt: null }];
  tables.reorderRule = [];
});

const body = { productId: PA, minQty: 5, reorderQty: 20 };

describe('reorder rules CRUD', () => {
  it('creates a rule, audits it, and the report (list) returns its data', async () => {
    const res = await request(app).post(`/stores/${A}/stock/reorder-rules`).send(body);
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({
      storeId: A,
      productId: PA,
      variantId: null,
      minQty: 5,
      reorderQty: 20,
      leadTimeDays: 7,
      safetyStockDays: 7,
      isActive: true,
      product: { name: 'Tee' },
    });
    expect(audit).toEqual([
      expect.objectContaining({
        action: 'reorder_rule.created',
        storeId: A,
        resourceId: res.body.data.id,
      }),
    ]);
    const list = await request(app).get(`/stores/${A}/stock/reorder-rules`);
    expect(list.status).toBe(200);
    expect(list.body.data).toHaveLength(1);
    expect(list.body.data[0]).toMatchObject({ id: res.body.data.id, minQty: 5, reorderQty: 20 });
  });

  it('edits and deletes a rule, auditing both', async () => {
    const { body: created } = await request(app)
      .post(`/stores/${A}/stock/reorder-rules`)
      .send(body);
    const id = created.data.id;
    const patched = await request(app)
      .patch(`/stores/${A}/stock/reorder-rules/${id}`)
      .send({ minQty: 9, isActive: false });
    expect(patched.status).toBe(200);
    expect(patched.body.data).toMatchObject({ minQty: 9, reorderQty: 20, isActive: false });
    const del = await request(app).delete(`/stores/${A}/stock/reorder-rules/${id}`);
    expect(del.status).toBe(204);
    expect(tables.reorderRule).toHaveLength(0);
    expect(audit.map(a => a.action)).toEqual([
      'reorder_rule.created',
      'reorder_rule.updated',
      'reorder_rule.deleted',
    ]);
  });

  it('a duplicate (store, product, variant) answers a clean 409 and writes nothing', async () => {
    await request(app).post(`/stores/${A}/stock/reorder-rules`).send(body);
    const dup = await request(app).post(`/stores/${A}/stock/reorder-rules`).send(body);
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('REORDER_RULE_EXISTS');
    expect(tables.reorderRule).toHaveLength(1);
    // the same product at variant level is a different rule
    const v = await request(app)
      .post(`/stores/${A}/stock/reorder-rules`)
      .send({ ...body, variantId: VA });
    expect(v.status).toBe(201);
    const vDup = await request(app)
      .post(`/stores/${A}/stock/reorder-rules`)
      .send({ ...body, variantId: VA });
    expect(vDup.status).toBe(409);
  });

  it('store B cannot read, edit or delete store A rule, nor attach A or B foreign ids', async () => {
    const { body: created } = await request(app)
      .post(`/stores/${A}/stock/reorder-rules`)
      .send(body);
    const id = created.data.id;
    expect((await request(app).get(`/stores/${B}/stock/reorder-rules`)).body.data).toEqual([]);
    expect(
      (await request(app).patch(`/stores/${B}/stock/reorder-rules/${id}`).send({ minQty: 99 }))
        .status
    ).toBe(404);
    expect((await request(app).delete(`/stores/${B}/stock/reorder-rules/${id}`)).status).toBe(404);
    expect(tables.reorderRule[0]).toMatchObject({ minQty: 5 });
    // product of A through store B, supplier of B on a rule of A
    expect((await request(app).post(`/stores/${B}/stock/reorder-rules`).send(body)).status).toBe(
      404
    );
    expect(
      (
        await request(app)
          .post(`/stores/${A}/stock/reorder-rules`)
          .send({ productId: PA, variantId: VA, minQty: 1, reorderQty: 1, preferredSupplierId: SB })
      ).status
    ).toBe(404);
    expect(tables.reorderRule).toHaveLength(1);
  });

  it('validates the body at the edge (422) and never reaches the store', async () => {
    for (const bad of [
      { productId: 'nope', minQty: 1, reorderQty: 1 },
      { productId: PA, minQty: -1, reorderQty: 1 },
      { productId: PA, minQty: 1, reorderQty: 0 },
      { productId: PA, minQty: 1.5, reorderQty: 1 },
      { ...body, storeId: B },
    ]) {
      const r = await request(app).post(`/stores/${A}/stock/reorder-rules`).send(bad);
      expect(r.status).toBe(422);
    }
    const id = '99999999-9999-4999-8999-999999999999';
    expect(
      (await request(app).patch(`/stores/${A}/stock/reorder-rules/${id}`).send({})).status
    ).toBe(422);
    expect(
      (await request(app).patch(`/stores/${A}/stock/reorder-rules/not-a-uuid`).send({ minQty: 1 }))
        .status
    ).toBe(422);
    expect(tables.reorderRule).toHaveLength(0);
    expect(audit).toHaveLength(0);
  });
});
