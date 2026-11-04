/**
 * CSV bulk stock-adjustment import against real Postgres.
 *
 *  - #226: a retried import (same idempotencyKey) must not post the stock and
 *    GL movement twice — sequentially OR concurrently. In delta mode a second
 *    import used to re-read the stock the first had already moved and apply
 *    the delta again.
 *  - #226: two concurrent posts of one draft must write the inventory ledger
 *    once (the draft→posted transition is a conditional claim).
 *  - #225: identifiers are resolved in batched queries; the results must be
 *    the same as the per-row lookups they replace — variant SKU first, then
 *    product SKU, soft-deleted products ignored.
 *  - Inventory model: a product-level row aimed at a product WITH variants is
 *    rejected per row instead of writing a parent column that moves nothing.
 *
 * Mounts only stock-adjustments.routes with the auth chain stubbed (the same
 * pattern as the unit route tests); Prisma, the services and the parser all
 * run for real. Retry-safe: every fixture is per-call unique.
 */
import { describe, it, expect, vi, beforeAll } from 'vitest';
import express from 'express';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { prisma } from '@ebda/database';

vi.mock('../../apps/api/src/middleware/auth', () => ({
  rejectImpersonated: (_q: any, _s: any, n: any) => n(),
  authenticate: (req: any, _res: any, next: any) => {
    req.user = { userId: undefined, role: 'store_admin' };
    next();
  },
  authorize:
    (..._roles: string[]) =>
    (_req: any, _res: any, next: any) =>
      next(),
}));
vi.mock('../../apps/api/src/middleware/store-access', () => ({
  requireStoreAccess: (_req: any, _res: any, next: any) => next(),
}));
vi.mock('../../apps/api/src/middleware/feature-gate', () => ({
  requireFeature:
    (..._args: unknown[]) =>
    (_req: any, _res: any, next: any) =>
      next(),
}));
vi.mock('../../apps/api/src/middleware/security', () => ({
  writeLimiter: (_req: any, _res: any, next: any) => next(),
}));
vi.mock('../../apps/api/src/lib/inngest/client', () => ({
  inngest: { send: vi.fn(async () => ({ ids: [] })), createFunction: vi.fn(() => ({})) },
}));

import stockAdjustmentsRoutes from '../../apps/api/src/routes/stock-adjustments.routes';
import {
  createAdjustment,
  postAdjustment,
} from '../../apps/api/src/services/accounting/stock-adjustment.service';

const OWNER_ID = '00000000-0000-0000-0000-000000002260';
let storeId: string;

const app = express();
app.use(express.json({ limit: '5mb' }));
app.use('/stores', stockAdjustmentsRoutes);
// Minimal error handler: AppError → its status, anything else → 500.
app.use((err: any, _req: any, res: any, _next: any) => {
  res.status(err?.statusCode ?? 500).json({ error: err?.code ?? 'error' });
});

beforeAll(async () => {
  await prisma.user.upsert({
    where: { id: OWNER_ID },
    update: {},
    create: {
      id: OWNER_ID,
      email: `csv-import-owner-${Date.now()}@example.test`,
      passwordHash: 'x',
      firstName: 'Csv',
      lastName: 'Import',
    },
  });
  const slug = `csv-import-${randomUUID().slice(0, 8)}`;
  const store = await prisma.store.create({ data: { name: slug, slug, ownerId: OWNER_ID } });
  storeId = store.id;
});

async function makeProduct(inventory: number, opts: { deleted?: boolean; sku?: string } = {}) {
  const id = randomUUID().slice(0, 8);
  return prisma.product.create({
    data: {
      storeId,
      name: `CSV ${id}`,
      slug: `csv-${id}`,
      sku: opts.sku ?? `SKU-${id}`,
      price: 1000,
      costPrice: 400,
      inventory,
      status: 'active',
      deletedAt: opts.deleted ? new Date() : null,
    },
  });
}

function importCsv(csvContent: string, idempotencyKey?: string) {
  return request(app)
    .post(`/stores/${storeId}/stock-adjustments/csv-import`)
    .send({ csvContent, type: 'cycle_count', idempotencyKey });
}

const stockOf = async (id: string) =>
  (await prisma.product.findUniqueOrThrow({ where: { id } })).inventory;

describe('csv-import idempotency (#226)', () => {
  it('a sequential retry with the same key replays the first import instead of re-applying the delta', async () => {
    const product = await makeProduct(100);
    const key = randomUUID();
    const csv = `SKU,Delta\n${product.sku},-5\n`;

    const first = await importCsv(csv, key);
    expect(first.status).toBe(201);
    expect(first.body.data.posted).toBe(true);

    const retry = await importCsv(csv, key);
    expect(retry.status).toBe(200);
    expect(retry.body.data.replayed).toBe(true);
    expect(retry.body.data.adjustmentId).toBe(first.body.data.adjustmentId);

    expect(await stockOf(product.id)).toBe(95);
    expect(await prisma.stockAdjustment.count({ where: { storeId, importKey: key } })).toBe(1);

    // The replay is answered BEFORE createAdjustment runs, so the retry does
    // not burn an adjustment number: the next real import is consecutive.
    const next = await importCsv(`SKU,Delta\n${product.sku},-1\n`, randomUUID());
    const seq = (n: string) => Number(n.match(/(\d+)$/)![1]);
    expect(seq(next.body.data.adjustmentNumber)).toBe(seq(first.body.data.adjustmentNumber) + 1);
  });

  it('concurrent submits with the same key post exactly one adjustment', async () => {
    const product = await makeProduct(50);
    const key = randomUUID();
    const csv = `SKU,Delta\n${product.sku},-10\n`;

    const responses = await Promise.all([1, 2, 3, 4].map(() => importCsv(csv, key)));

    expect(responses.map(r => r.status).sort()).toEqual([200, 200, 200, 201]);
    expect(new Set(responses.map(r => r.body.data.adjustmentId)).size).toBe(1);
    expect(await stockOf(product.id)).toBe(40);
    expect(await prisma.inventoryHistory.count({ where: { storeId, productId: product.id } })).toBe(
      1
    );
  });

  it('a new key (a deliberate re-import) still imports again (control)', async () => {
    const product = await makeProduct(20);
    const csv = `SKU,Delta\n${product.sku},-1\n`;

    expect((await importCsv(csv, randomUUID())).status).toBe(201);
    expect((await importCsv(csv, randomUUID())).status).toBe(201);
    expect(await stockOf(product.id)).toBe(18);
  });
});

describe('postAdjustment draft claim (#226)', () => {
  it('two concurrent posts of one draft write the inventory ledger once', async () => {
    const product = await makeProduct(10);
    const draft = await createAdjustment({
      storeId,
      type: 'cycle_count',
      items: [{ productId: product.id, newQty: 7 }],
    });

    const results = await Promise.allSettled([
      postAdjustment(storeId, draft.id),
      postAdjustment(storeId, draft.id),
    ]);

    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find(r => r.status === 'rejected') as PromiseRejectedResult;
    expect(rejected.reason).toMatchObject({ statusCode: 409, code: 'ALREADY_POSTED' });
    expect(await prisma.inventoryHistory.count({ where: { storeId, productId: product.id } })).toBe(
      1
    );
  });
});

describe('batched identifier resolution (#225)', () => {
  it('resolves variant SKUs before product SKUs, skips soft-deleted products, and rejects product-level rows on variant products', async () => {
    const plain = await makeProduct(5);
    const withVariants = await makeProduct(0);
    const variantSku = `VAR-${randomUUID().slice(0, 8)}`;
    const variant = await prisma.productVariant.create({
      data: {
        productId: withVariants.id,
        title: 'Red',
        sku: variantSku,
        price: 1000,
        inventory: 30,
      },
    });
    const reusedSku = `REUSED-${randomUUID().slice(0, 8)}`;
    await makeProduct(999, { deleted: true, sku: reusedSku });
    const live = await makeProduct(3, { sku: reusedSku });

    const csv = [
      'SKU,New Quantity,Delta',
      `${plain.sku},8,`,
      `${variantSku},,4`,
      `${withVariants.sku},12,`,
      `${reusedSku},,2`,
      `NOPE-${randomUUID().slice(0, 6)},1,`,
    ].join('\n');

    const res = await importCsv(csv, randomUUID());
    expect(res.status).toBe(201);
    expect(res.body.data.importedRows).toBe(3);
    expect(Object.keys(res.body.data.errors).sort()).toEqual(['3', '5']);
    expect(res.body.data.errors['3'][0]).toMatch(/variants/);

    expect(await stockOf(plain.id)).toBe(8);
    expect(
      (await prisma.productVariant.findUniqueOrThrow({ where: { id: variant.id } })).inventory
    ).toBe(34);
    expect(await stockOf(withVariants.id)).toBe(0); // parent column untouched
    expect(await stockOf(live.id)).toBe(5); // live product, not the deleted one
  });
});
