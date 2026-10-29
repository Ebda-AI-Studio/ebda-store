/**
 * INFRA-CF-1 PR D2a (Ruling CF-STOCK-1): every stock operation moved to the StoreDO gives the same answer and leaves the same
 * rows on Postgres and on the DO. Each test is a SCENARIO driving the real services (`InventoryService`, `VariantService`,
 * `WarehouseService`); it runs once on Postgres (the unchanged Postgres code, inside the store's tenant scope) and once with
 * the DO stock client over the real DO schema on SQLite (the real wire codec, `answerStockOp`, `runStockOp`, the same
 * seeded rows). The scrubbed traces (return values or error code + status, then the stock tables) must be equal.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '@ebda/database';
import {
  answerStockOp,
  createDoClient,
  createPrismaLite,
  decodeRpc,
  encodeRpc,
  ensureIdempotencySchema,
  ensureStockOpsSchema,
  runReads,
  runWrites,
} from '@ebda-src/repo';
import { InventoryService } from '../../apps/api/src/services/inventory.service';
import { VariantService } from '../../apps/api/src/services/variant.service';
import { WarehouseService } from '../../apps/api/src/services/warehouse.service';
import {
  makeStockClient,
  withRepo,
  type StoreReads,
  type StoreWrites,
} from '../../apps/api/src/lib/repo-factory';
import { AppError } from '../../apps/api/src/middleware/error-handler';
import { META, canon, insertSqlite, openSqlite } from '../../packages/repo/test/diff-harness';
import { nodeSqlRunner } from '../../packages/repo/test/node-sql';
import { nodeSyncSql } from '../../packages/repo/test/node-sync-sql';

const sfx = Date.now().toString(36);
let STORE = '';
let userId = '';
const sqlite = openSqlite();

function doRepo() {
  const sql = nodeSqlRunner(sqlite);
  ensureIdempotencySchema(sql);
  const sync = nodeSyncSql(sqlite);
  ensureStockOpsSchema(sync);
  const lite = createPrismaLite(META as never, sql, 'store-do', { storeId: STORE }) as never;
  const c = createDoClient(
    q => runReads(lite, q),
    m => runWrites(lite, sql, m)
  ) as never;
  const stock = makeStockClient(async (op, args, key) => {
    const r = answerStockOp(sync, STORE, op, encodeRpc(args), key);
    if (!r.ok) throw new AppError(r.status, r.code, r.message);
    return decodeRpc(r.json);
  });
  return {
    storeId: STORE,
    backend: 'do' as const,
    db: c as StoreReads,
    writer: c as StoreWrites,
    stock,
  };
}
const pgRepo = () => ({
  storeId: STORE,
  backend: 'pg' as const,
  db: prisma as never,
  writer: prisma as never,
});

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;
function scrub(v: unknown): unknown {
  const text = JSON.stringify(canon(v)) ?? 'null';
  return JSON.parse(text.replace(UUID, '<id>').replace(/"\d{4}-\d\d-\d\dT[\d:.]+Z"/g, '"<date>"'));
}
const settle = async <T>(f: () => Promise<T>) =>
  f().then(
    v => ({ ok: v }),
    (e: { code?: string; statusCode?: number; message?: string }) => ({
      err: {
        code: e.code,
        status: e.statusCode,
        message: e.code ? undefined : String(e.message).slice(0, 160),
      },
    })
  );
// No ambient request transaction on purpose: the stock services open their own money transactions (as in a job/CLI), and an
// outer open transaction holding the same product row would deadlock them against it (a harness artefact, not a defect).
const onPg = <T>(f: () => Promise<T>) => withRepo(pgRepo(), f);
const onDo = <T>(f: () => Promise<T>) => withRepo(doRepo(), f);

/** The stock tables as the CURRENT backend sees them, ids replaced by stable names so the two backends compare. */
async function state(names: Record<string, string>) {
  const w = (await import('../../apps/api/src/lib/repo-factory')).storeWriter;
  const db = (await w(STORE)) as any;
  const ids = Object.keys(names);
  const name = (id: unknown) => (typeof id === 'string' ? (names[id] ?? id) : id);
  const products = await db.product.findMany({
    where: { storeId: STORE, id: { in: Object.keys(names).filter(k => !k.startsWith('v:')) } },
    orderBy: { slug: 'asc' },
    select: { id: true, inventory: true },
  });
  const variants = await db.productVariant.findMany({
    where: { productId: { in: Object.keys(names) } },
    orderBy: { sku: 'asc' },
    select: { id: true, inventory: true },
  });
  const wh = await db.warehouseStock.findMany({
    where: { storeId: STORE, productId: { in: ids } },
    select: { warehouseId: true, productId: true, variantId: true, quantity: true },
  });
  const hist = await db.inventoryHistory.findMany({
    where: { storeId: STORE, productId: { in: ids } },
    select: {
      productId: true,
      type: true,
      quantity: true,
      previousStock: true,
      newStock: true,
      reason: true,
      reference: true,
      createdBy: true,
    },
  });
  const sortKey = (r: any) => JSON.stringify(r);
  return {
    products: products.map((r: any) => ({ p: name(r.id), inv: r.inventory })),
    variants: variants.map((r: any) => ({ v: name(r.id), inv: r.inventory })),
    warehouseStock: wh
      .map((r: any) => ({
        w: name(r.warehouseId),
        p: name(r.productId),
        v: name(r.variantId),
        q: r.quantity,
      }))
      .sort((a: any, b: any) => sortKey(a).localeCompare(sortKey(b))),
    history: hist
      .map((r: any) => ({ ...r, productId: name(r.productId), reference: name(r.reference) }))
      .sort((a: any, b: any) => sortKey(a).localeCompare(sortKey(b))),
  };
}

interface Fx {
  plain: string;
  shirt: string;
  v1: string;
  v2: string;
  w1: string;
  w2: string;
  names: Record<string, string>;
}
let n = 0;
/** Fresh store-scoped fixtures, on Postgres and (same ids) in SQLite. */
async function fixtures(): Promise<Fx> {
  const k = `${sfx}${++n}`;
  const plain = await prisma.product.create({
    data: {
      storeId: STORE,
      name: `Plain ${k}`,
      slug: `plain-${k}`,
      price: 1000,
      inventory: 10,
      status: 'active',
    },
  });
  const shirt = await prisma.product.create({
    data: {
      storeId: STORE,
      name: `Shirt ${k}`,
      slug: `shirt-${k}`,
      price: 0,
      inventory: 0,
      status: 'active',
    },
  });
  const v1 = await prisma.productVariant.create({
    data: { productId: shirt.id, title: 'M', sku: `m-${k}`, price: 100, inventory: 3 },
  });
  const v2 = await prisma.productVariant.create({
    data: { productId: shirt.id, title: 'L', sku: `l-${k}`, price: 100, inventory: 4 },
  });
  const w1 = await prisma.warehouse.create({
    data: { storeId: STORE, name: 'Main', code: `MAIN-${k}`, isDefault: true },
  });
  const w2 = await prisma.warehouse.create({
    data: { storeId: STORE, name: 'Second', code: `SEC-${k}` },
  });
  insertSqlite(sqlite, 'Product', [plain, shirt] as never);
  insertSqlite(sqlite, 'ProductVariant', [v1, v2] as never);
  insertSqlite(sqlite, 'Warehouse', [w1, w2] as never);
  return {
    plain: plain.id,
    shirt: shirt.id,
    v1: v1.id,
    v2: v2.id,
    w1: w1.id,
    w2: w2.id,
    names: {
      [plain.id]: 'plain',
      [shirt.id]: 'shirt',
      [v1.id]: 'v1',
      [v2.id]: 'v2',
      [w1.id]: 'w1',
      [w2.id]: 'w2',
    },
  };
}

/** Both backends run the scenario; each yields {result or error, resulting stock tables}; they must be equal. */
async function parity(fx: Fx, scenario: () => Promise<unknown>) {
  const run = async (on: typeof onPg) => {
    const out = await settle(() => on(scenario));
    return scrub({ out, state: await on(() => state(fx.names)) });
  };
  const pg = await run(onPg);
  const dobj = await run(onDo);
  expect(dobj).toEqual(pg);
  return pg as any;
}

beforeAll(async () => {
  const user = await prisma.user.create({
    data: {
      email: `d2a-${sfx}@example.test`,
      passwordHash: 'x',
      firstName: 'D',
      lastName: 'A',
      role: 'store_admin',
      status: 'active',
      emailVerified: true,
    },
  });
  userId = user.id;
  STORE = (
    await prisma.store.create({
      data: { name: 'D2a', slug: `d2a-${sfx}`, ownerId: userId, status: 'active' },
    })
  ).id;
});
afterAll(async () => {
  await prisma.store.deleteMany({ where: { id: STORE } });
  await prisma.user.deleteMany({ where: { id: userId } });
  await prisma.$disconnect();
});

describe('product stock (InventoryService)', () => {
  it('adjustInventory: removal, addition, and the refusals (below zero, variant product, unknown product)', async () => {
    const fx = await fixtures();
    const t = await parity(fx, async () => ({
      a: await InventoryService.adjustInventory(
        STORE,
        {
          productId: fx.plain,
          quantity: -4,
          type: 'manual_remove',
          reason: 'broken',
          reference: 'ref-1',
        },
        userId
      ),
      b: await InventoryService.adjustInventory(
        STORE,
        { productId: fx.plain, quantity: 9, type: 'manual_add' },
        userId
      ),
      tooMuch: await settle(() =>
        InventoryService.adjustInventory(
          STORE,
          { productId: fx.plain, quantity: -99, type: 'manual_remove' },
          userId
        )
      ),
      variantProduct: await settle(() =>
        InventoryService.adjustInventory(
          STORE,
          { productId: fx.shirt, quantity: 1, type: 'manual_add' },
          userId
        )
      ),
      unknown: await settle(() =>
        InventoryService.adjustInventory(
          STORE,
          { productId: '00000000-0000-4000-8000-000000000000', quantity: 1, type: 'manual_add' },
          userId
        )
      ),
    }));
    expect(t.state.products.find((p: any) => p.p === 'plain').inv).toBe(15);
    expect(t.out.ok.tooMuch.err.code).toBe('INSUFFICIENT_STOCK');
  });

  it('setInventory: a count with and without a reason', async () => {
    const fx = await fixtures();
    const t = await parity(fx, async () => ({
      a: await InventoryService.setInventory(STORE, fx.plain, 25, 'recount', userId),
      b: await InventoryService.setInventory(STORE, fx.plain, 0, undefined, userId),
    }));
    expect(t.state.history).toHaveLength(2);
  });

  it('bulkAdjustInventory: a bad row fails alone, the rest apply with one history row each', async () => {
    const fx = await fixtures();
    const t = await parity(fx, async () =>
      InventoryService.bulkAdjustInventory(
        STORE,
        [
          { productId: fx.plain, quantity: 5, type: 'manual_add', reason: 'delivery' },
          { productId: '00000000-0000-4000-8000-000000000000', quantity: 1, type: 'manual_add' },
          { productId: fx.shirt, quantity: 1, type: 'manual_add' },
          { productId: fx.plain, quantity: -500, type: 'manual_remove' },
        ],
        userId
      )
    );
    expect(t.out.ok).toMatchObject({ successful: 1, failed: 3 });
  });
});

describe('variant stock (VariantService.bulkUpdateInventory)', () => {
  it('sets per variant; a variant of another product fails alone; a missing product is 404', async () => {
    const fx = await fixtures();
    const t = await parity(fx, async () => ({
      ok: await VariantService.bulkUpdateInventory(STORE, fx.shirt, [
        { variantId: fx.v1, inventory: 9 },
        { variantId: fx.v2, inventory: 0 },
        { variantId: '00000000-0000-4000-8000-000000000000', inventory: 1 },
      ]),
      missing: await settle(() =>
        VariantService.bulkUpdateInventory(STORE, '00000000-0000-4000-8000-000000000000', [])
      ),
    }));
    expect(t.out.ok.ok).toEqual({ updated: 2, failed: 1 });
  });
});

describe('warehouse stock (WarehouseService)', () => {
  it('setStock + adjustStock keep the aggregate equal to the sum of the warehouses, floor at zero, write the audit row', async () => {
    const fx = await fixtures();
    const t = await parity(fx, async () => ({
      s1: await WarehouseService.setStock(STORE, fx.w1, { productId: fx.plain, quantity: 7 }),
      s2: await WarehouseService.setStock(STORE, fx.w2, { productId: fx.plain, quantity: 5 }),
      adj: await WarehouseService.adjustStock(STORE, fx.w1, {
        productId: fx.plain,
        delta: -20,
        reason: 'lost',
      }),
      up: await WarehouseService.adjustStock(STORE, fx.w2, { productId: fx.plain, delta: 3 }),
    }));
    expect(t.state.products.find((p: any) => p.p === 'plain').inv).toBe(8);
  });

  it('per-variant rows roll up onto the variant; the refusals carry the same codes', async () => {
    const fx = await fixtures();
    const t = await parity(fx, async () => ({
      a: await WarehouseService.setStock(STORE, fx.w1, {
        productId: fx.shirt,
        variantId: fx.v1,
        quantity: 2,
      }),
      b: await WarehouseService.adjustStock(STORE, fx.w2, {
        productId: fx.shirt,
        variantId: fx.v1,
        delta: 3,
      }),
      variantProductLevel: await settle(() =>
        WarehouseService.setStock(STORE, fx.w1, { productId: fx.shirt, quantity: 1 })
      ),
      noWarehouse: await settle(() =>
        WarehouseService.setStock(STORE, '00000000-0000-4000-8000-000000000000', {
          productId: fx.plain,
          quantity: 1,
        })
      ),
      negative: await settle(() =>
        WarehouseService.setStock(STORE, fx.w1, { productId: fx.plain, quantity: -1 })
      ),
    }));
    expect(t.state.variants.find((v: any) => v.v === 'v1').inv).toBe(5);
  });

  it('a product-level count re-syncs the default warehouse shadow (Postgres: post-commit; DO: same section)', async () => {
    const fx = await fixtures();
    await parity(fx, async () => {
      await WarehouseService.setStock(STORE, fx.w2, { productId: fx.plain, quantity: 4 });
      await InventoryService.adjustInventory(
        STORE,
        { productId: fx.plain, quantity: 6, type: 'manual_add' },
        userId
      );
      return InventoryService.setInventory(STORE, fx.plain, 3, 'count', userId);
    });
  });

  it('WAREHOUSE-NEG-1: a count below the shadow sum spreads the deficit, no warehouse row goes negative', async () => {
    const fx = await fixtures();
    const t = await parity(fx, async () => {
      await WarehouseService.setStock(STORE, fx.w1, { productId: fx.plain, quantity: 2 });
      await WarehouseService.setStock(STORE, fx.w2, { productId: fx.plain, quantity: 10 });
      return InventoryService.setInventory(STORE, fx.plain, 3, 'count', userId);
    });
    const rows = t.state.warehouseStock as Array<{ q: number }>;
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.map(r => r.q).sort()).toEqual([0, 3]);
  });
});
