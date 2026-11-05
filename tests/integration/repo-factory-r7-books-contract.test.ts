/**
 * INFRA-CF-1 R7 (Rulings CF-R7-1, CF-R7-2): the flows the flip gate listed as `postgresOnly` (accounting: purchase orders,
 * stock adjustments, the opening-balance journal; the barcode scan stock flows; the product bulk-update inventory field) and the
 * COD settlement import give the same answer and leave the same rows on Postgres and on the Durable Object. Each scenario drives
 * the REAL service once with the store on Postgres (the unchanged Postgres code) and once with the DO stock client over the real
 * DO schema on SQLite (real wire codec, `answerStockOp`, `runStockOp`); the scrubbed traces (return value or error code +
 * status, then the tables the flow writes) must be equal.
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
import {
  createAdjustment,
  findAdjustmentByImportKey,
  postAdjustment,
} from '../../apps/api/src/services/accounting/stock-adjustment.service';
import {
  cancelPurchaseOrder,
  createPurchaseOrder,
  getPurchaseOrder,
  listPurchaseOrders,
  receivePurchaseOrder,
} from '../../apps/api/src/services/accounting/purchase-order.service';
import { seedCoaForStore } from '../../apps/api/src/services/accounting/account.service';
import {
  closeCountSession,
  getCountSession,
  openCountSession,
  receiveByBarcode,
  reconcileCountSession,
  submitCountLine,
} from '../../apps/api/src/services/barcode-scan.service';
import { ProductService } from '../../apps/api/src/services/product.service';
import { CodReconciliationService } from '../../apps/api/src/services/cod-reconciliation.service';
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
import { hasDb } from '../helpers/bundle-fixtures';

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
const onPg = <T>(f: () => Promise<T>) => withRepo(pgRepo(), f);
const onDo = <T>(f: () => Promise<T>) => withRepo(doRepo(), f);

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;
/** Child arrays a service returns without an ORDER BY (a PO's or adjustment's lines): equal as sets, not as sequences. */
function sortChildren(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortChildren);
  if (v && typeof v === 'object')
    return Object.fromEntries(
      Object.entries(v as Record<string, unknown>).map(([k, x]) => {
        const y = sortChildren(x);
        return [
          k,
          (k === 'items' || k === 'lines') && Array.isArray(y)
            ? [...y].sort((a, b) =>
                JSON.stringify(a, Object.keys(a as object).sort()).localeCompare(
                  JSON.stringify(b, Object.keys(b as object).sort())
                )
              )
            : y,
        ];
      })
    );
  return v;
}
function scrub(v: unknown, names: Record<string, string>): unknown {
  let text = JSON.stringify(sortChildren(canon(v))) ?? 'null';
  for (const [id, name] of Object.entries(names)) text = text.split(id).join(`<${name}>`);
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

/** The tables these flows write, as the CURRENT backend sees them (the repo client reads PG on pg and the DO on do). */
async function state(names: Record<string, string>) {
  const { storeDb } = await import('../../apps/api/src/lib/repo-factory');
  const db = (await storeDb(STORE)) as any;
  const pids = Object.keys(names);
  const sortBy = (k: string) => (a: any, b: any) =>
    JSON.stringify(a[k] ?? a).localeCompare(JSON.stringify(b[k] ?? b));
  const products = await db.product.findMany({
    where: { storeId: STORE },
    select: { slug: true, inventory: true, costPrice: true },
    orderBy: { slug: 'asc' },
  });
  const variants = await db.productVariant.findMany({
    where: { productId: { in: pids } },
    select: { sku: true, inventory: true, costPrice: true },
    orderBy: { sku: 'asc' },
  });
  const history = await db.inventoryHistory.findMany({
    where: { storeId: STORE },
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
  const adjustments = await db.stockAdjustment.findMany({
    where: { storeId: STORE },
    select: {
      adjustmentNumber: true,
      type: true,
      status: true,
      reason: true,
      totalValueImpact: true,
      importKey: true,
      createdBy: true,
      postedBy: true,
      items: {
        select: {
          productId: true,
          variantId: true,
          previousQty: true,
          newQty: true,
          deltaQty: true,
          unitCost: true,
        },
      },
    },
    orderBy: { adjustmentNumber: 'asc' },
  });
  const pos = await db.purchaseOrder.findMany({
    where: { storeId: STORE },
    select: {
      poNumber: true,
      status: true,
      subtotal: true,
      total: true,
      notes: true,
      apAccountId: true,
      receivedBy: true,
      items: {
        select: { productId: true, variantId: true, qty: true, qtyReceived: true, unitCost: true },
      },
    },
    orderBy: { poNumber: 'asc' },
  });
  const accounts = await db.account.findMany({
    where: { storeId: STORE },
    select: { code: true, type: true, isSystem: true },
    orderBy: { code: 'asc' },
  });
  const journals = await db.journalEntry.findMany({
    where: { storeId: STORE },
    select: {
      entryNumber: true,
      source: true,
      memo: true,
      lines: { select: { debit: true, credit: true, account: { select: { code: true } } } },
    },
    orderBy: { entryNumber: 'asc' },
  });
  const sessions = await db.countSession.findMany({
    where: { storeId: STORE },
    select: {
      status: true,
      note: true,
      lines: {
        select: {
          productId: true,
          variantId: true,
          countedQty: true,
          systemQty: true,
          variance: true,
        },
      },
    },
    orderBy: { createdAt: 'asc' },
  });
  const remittances = await db.codRemittance.findMany({
    where: { storeId: STORE },
    select: {
      shipmentId: true,
      carrier: true,
      trackingNumber: true,
      lineRef: true,
      grossAmount: true,
      feeAmount: true,
      netAmount: true,
      source: true,
    },
    orderBy: { lineRef: 'asc' },
  });
  const backorders = await db.backorderLine.findMany({
    where: { storeId: STORE },
    select: { orderItemId: true, qty: true, qtyFulfilled: true, fulfilledAt: true },
    orderBy: { qty: 'asc' },
  });
  const items = await db.orderItem.findMany({
    where: { order: { storeId: STORE } },
    select: { id: true, costPriceDeferred: true },
    orderBy: { id: 'asc' },
  });
  return {
    products,
    variants,
    history: history.sort(sortBy('x')),
    adjustments,
    pos,
    accounts,
    journals: journals.map((j: any) => ({
      ...j,
      lines: j.lines
        .map((l: any) => ({ code: l.account.code, debit: l.debit, credit: l.credit }))
        .sort(sortBy('x')),
    })),
    sessions,
    remittances,
    backorders: backorders.map((b: any) => ({ ...b, item: names[b.orderItemId] })),
    items,
  };
}

interface Fx {
  names: Record<string, string>;
  plain: string;
  shirt: string;
  v1: string;
  v2: string;
  supplier: string;
  k: string;
  [k: string]: unknown;
}
let n = 0;
async function newStore(): Promise<string> {
  const k = `${sfx}${++n}`;
  return (
    await prisma.store.create({
      data: { name: `R7 ${k}`, slug: `r7-${k}`, ownerId: userId, status: 'active' },
    })
  ).id;
}

/** Fresh fixtures for ONE scenario: a plain product, a two-variant product, a supplier, the system accounts. */
async function fixtures(opts: { accounts?: boolean } = {}): Promise<Fx> {
  const k = `${sfx}${++n}`;
  const plain = await prisma.product.create({
    data: {
      storeId: STORE,
      name: `Plain ${k}`,
      slug: `plain-${k}`,
      price: 1000,
      inventory: 10,
      costPrice: 100,
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
      costPrice: 50,
      status: 'active',
      hasVariants: true,
    },
  });
  const v1 = await prisma.productVariant.create({
    data: {
      productId: shirt.id,
      title: 'M',
      sku: `m-${k}`,
      barcode: `R7BC${k}`,
      price: 100,
      inventory: 3,
      costPrice: 60,
    },
  });
  const v2 = await prisma.productVariant.create({
    data: { productId: shirt.id, title: 'L', sku: `l-${k}`, price: 100, inventory: 4 },
  });
  const supplier = await prisma.supplier.create({ data: { storeId: STORE, name: `Sup ${k}` } });
  insertSqlite(sqlite, 'Product', [plain, shirt] as never);
  insertSqlite(sqlite, 'ProductVariant', [v1, v2] as never);
  insertSqlite(sqlite, 'Supplier', [supplier] as never);
  const names: Record<string, string> = {
    [plain.id]: 'plain',
    [shirt.id]: 'shirt',
    [v1.id]: 'v1',
    [v2.id]: 'v2',
    [supplier.id]: 'supplier',
  };
  if (opts.accounts) {
    // once per store: the same three system accounts are shared by every scenario of the store
    const have = await prisma.account.findMany({ where: { storeId: STORE } });
    if (have.length === 0) {
      for (const [code, type] of [
        ['1200', 'asset'],
        ['2000', 'liability'],
        ['3000', 'equity'],
      ] as const) {
        const a = await prisma.account.create({
          data: { storeId: STORE, code, nameEn: code, type, isSystem: true },
        });
        insertSqlite(sqlite, 'Account', [a] as never);
      }
    }
    for (const a of await prisma.account.findMany({ where: { storeId: STORE } }))
      names[a.id] = `acct${a.code}`;
  }
  return {
    names,
    plain: plain.id,
    shirt: shirt.id,
    v1: v1.id,
    v2: v2.id,
    supplier: supplier.id,
    k,
    v1Barcode: v1.barcode,
  };
}

async function parity(fx: Fx, scenario: () => Promise<unknown>) {
  const run = async (on: typeof onPg) => {
    const out = await settle(() => on(scenario));
    return scrub({ out, state: await on(() => state(fx.names)) }, fx.names);
  };
  const pg = await run(onPg);
  const dobj = await run(onDo);
  expect(dobj).toEqual(pg);
  return pg as any;
}

beforeAll(async () => {
  if (!hasDb) return;
  const user = await prisma.user.create({
    data: {
      email: `r7-${sfx}@example.test`,
      passwordHash: 'x',
      firstName: 'R',
      lastName: 'S',
      role: 'store_admin',
      status: 'active',
      emailVerified: true,
    },
  });
  userId = user.id;
  STORE = await newStore();
});
afterAll(async () => {
  if (!hasDb) return;
  const stores = (
    await prisma.store.findMany({ where: { ownerId: userId }, select: { id: true } })
  ).map(x => x.id);
  await prisma.journalEntry.deleteMany({ where: { storeId: { in: stores } } });
  await prisma.purchaseOrder.deleteMany({ where: { storeId: { in: stores } } });
  await prisma.stockAdjustment.deleteMany({ where: { storeId: { in: stores } } });
  await prisma.countSession.deleteMany({ where: { storeId: { in: stores } } });
  await prisma.codRemittance.deleteMany({ where: { storeId: { in: stores } } });
  await prisma.shipment.deleteMany({ where: { storeId: { in: stores } } });
  await prisma.backorderLine.deleteMany({ where: { storeId: { in: stores } } });
  await prisma.order.deleteMany({ where: { storeId: { in: stores } } });
  await prisma.store.deleteMany({ where: { id: { in: stores } } });
  await prisma.user.deleteMany({ where: { id: userId } });
  await prisma.$disconnect();
});

describe.skipIf(!hasDb)('stock adjustments (stock-adjustment.service)', () => {
  it('create + post: product and variant lines, the history rows, the value impact; a second post and a foreign id are refused', async () => {
    const fx = await fixtures({ accounts: true });
    const t = await parity(fx, async () => {
      const draft = await createAdjustment({
        storeId: STORE,
        type: 'damage',
        reason: 'broken in transit',
        createdBy: userId,
        items: [
          { productId: fx.plain, newQty: 7 },
          { productId: fx.shirt, variantId: fx.v1, newQty: 5 },
        ],
      });
      const posted = await postAdjustment(STORE, draft.id, userId);
      const again = await settle(() => postAdjustment(STORE, draft.id, userId));
      const foreign = await settle(() =>
        createAdjustment({
          storeId: STORE,
          type: 'found',
          items: [{ productId: '00000000-0000-4000-8000-000000000000', newQty: 1 }],
        })
      );
      return { posted, again, foreign };
    });
    expect(t.state.products.find((p: any) => p.slug === `plain-${fx.k}`)?.inventory).toBe(7);
    expect(t.out.ok.again.err).toMatchObject({ code: 'ALREADY_POSTED', status: 409 });
    expect(t.out.ok.foreign.err).toMatchObject({ code: 'NOT_FOUND', status: 404 });
  });

  it('a CSV import key is unique: the second create is a P2002 on import_key and the first is found by its key', async () => {
    // its own store: Postgres burns an ADJ number on the refused create (the sequence commits before the insert fails), the DO
    // rolls the claim back with the refusal, so the two sequences are compared only where no create is refused
    const saved = STORE;
    STORE = await newStore();
    try {
      const fx = await fixtures({ accounts: true });
      await parity(fx, async () => {
        const a = await createAdjustment({
          storeId: STORE,
          type: 'cycle_count',
          importKey: `imp-${sfx}-${fx.plain}`,
          items: [{ productId: fx.plain, newQty: 4 }],
        });
        const b = await settle(() =>
          createAdjustment({
            storeId: STORE,
            type: 'cycle_count',
            importKey: `imp-${sfx}-${fx.plain}`,
            items: [{ productId: fx.plain, newQty: 4 }],
          })
        );
        const found = await findAdjustmentByImportKey(STORE, `imp-${sfx}-${fx.plain}`);
        return {
          same: found?.id === a.id,
          items: found?._count.items,
          code: (b as any).err?.code,
          status: (b as any).err?.status,
        };
      });
    } finally {
      STORE = saved;
    }
  });
});

describe.skipIf(!hasDb)('purchase orders (purchase-order.service)', () => {
  it('draft, list/get, partial receive, complete receive, then the refusals', async () => {
    const fx = await fixtures({ accounts: true });
    const t = await parity(fx, async () => {
      const po = await createPurchaseOrder({
        storeId: STORE,
        supplierId: fx.supplier,
        createdBy: userId,
        notes: 'first order',
        items: [
          { productId: fx.plain, qty: 10, unitCost: 200 },
          { productId: fx.shirt, variantId: fx.v1, qty: 3, unitCost: 120 },
        ],
      });
      const items = (await getPurchaseOrder(STORE, po.id))!.items;
      const plainItem = items.find(i => i.productId === fx.plain)!;
      const variantItem = items.find(i => i.variantId === fx.v1)!;
      const partial = await receivePurchaseOrder({
        storeId: STORE,
        poId: po.id,
        receivedBy: userId,
        receipts: [
          { poItemId: plainItem.id, qtyReceived: 4 },
          { poItemId: variantItem.id, qtyReceived: 3 },
        ],
      });
      const over = await settle(() =>
        receivePurchaseOrder({
          storeId: STORE,
          poId: po.id,
          receipts: [{ poItemId: plainItem.id, qtyReceived: 7 }],
        })
      );
      const done = await receivePurchaseOrder({
        storeId: STORE,
        poId: po.id,
        receivedBy: userId,
        receipts: [{ poItemId: plainItem.id, qtyReceived: 6 }],
      });
      const after = await settle(() =>
        receivePurchaseOrder({
          storeId: STORE,
          poId: po.id,
          receipts: [{ poItemId: plainItem.id, qtyReceived: 1 }],
        })
      );
      const cancel = await settle(() => cancelPurchaseOrder(STORE, po.id));
      const list = await listPurchaseOrders(STORE, { status: 'received' });
      return {
        partial: partial.po.status,
        over,
        done: done.po.status,
        after,
        cancel,
        list: list.total,
      };
    });
    expect(t.out.ok.over.err).toMatchObject({ code: 'RECEIVE_EXCEEDS_QTY' });
    expect(t.out.ok.done).toBe('received');
    expect(t.out.ok.cancel.err).toMatchObject({ code: 'PO_ALREADY_RECEIVED' });
    // weighted average on the plain product: (10*100 + 4*200)/14 = 129, then 14 on hand + 6 at 200
    expect(t.state.pos).toHaveLength(1);
  });

  it('the variant rules: a variant product needs a variant per line, and a variant must belong to its product', async () => {
    const fx = await fixtures({ accounts: true });
    const t = await parity(fx, async () => ({
      noVariant: await settle(() =>
        createPurchaseOrder({
          storeId: STORE,
          supplierId: fx.supplier,
          items: [{ productId: fx.shirt, qty: 1, unitCost: 1 }],
        })
      ),
      mismatch: await settle(() =>
        createPurchaseOrder({
          storeId: STORE,
          supplierId: fx.supplier,
          items: [{ productId: fx.plain, variantId: fx.v1, qty: 1, unitCost: 1 }],
        })
      ),
      foreignSupplier: await settle(() =>
        createPurchaseOrder({
          storeId: STORE,
          supplierId: '00000000-0000-4000-8000-000000000000',
          items: [{ productId: fx.plain, qty: 1, unitCost: 1 }],
        })
      ),
    }));
    expect(t.out.ok.noVariant.err).toMatchObject({ code: 'VARIANT_REQUIRED' });
    expect(t.out.ok.mismatch.err).toMatchObject({ code: 'VARIANT_PRODUCT_MISMATCH' });
    expect(t.out.ok.foreignSupplier.err).toMatchObject({ code: 'NOT_FOUND' });
  });

  it('a receive clears the oldest backorder first, heals the stock debt and clears the deferred cost flag', async () => {
    const fx = await fixtures({ accounts: true });
    await prisma.product.update({
      where: { id: fx.plain, storeId: STORE },
      data: { inventory: -3 },
    });
    sqlite.prepare('UPDATE products SET inventory = -3 WHERE id = ?').run(fx.plain);
    const order = await prisma.order.create({
      data: {
        storeId: STORE,
        orderNumber: `R7-${sfx}-${++n}`,
        subtotal: 700,
        total: 700,
        status: 'confirmed',
        shippingAddress: {},
        billingAddress: {},
      } as never,
    });
    insertSqlite(sqlite, 'Order', [order as Record<string, unknown>]);
    const names = fx.names;
    for (const [i, qty] of [2, 5].entries()) {
      const item = await prisma.orderItem.create({
        data: {
          orderId: order.id,
          productId: fx.plain,
          productName: 'Plain',
          quantity: qty,
          price: 100,
          total: 100 * qty,
          costPrice: 150,
          costPriceDeferred: true,
        } as never,
      });
      insertSqlite(sqlite, 'OrderItem', [item as Record<string, unknown>]);
      names[item.id] = `item${i}`;
      const bo = await prisma.backorderLine.create({
        data: {
          storeId: STORE,
          orderItemId: item.id,
          productId: fx.plain,
          qty,
          createdAt: new Date(Date.now() - (10 - i) * 1000),
        } as never,
      });
      insertSqlite(sqlite, 'BackorderLine', [bo as Record<string, unknown>]);
    }
    const t = await parity(fx, async () => {
      const po = await createPurchaseOrder({
        storeId: STORE,
        supplierId: fx.supplier,
        items: [{ productId: fx.plain, qty: 4, unitCost: 250 }],
      });
      const item = (await getPurchaseOrder(STORE, po.id))!.items[0];
      const r = await receivePurchaseOrder({
        storeId: STORE,
        poId: po.id,
        receipts: [{ poItemId: item.id, qtyReceived: 4 }],
      });
      return r.clearedBackorders.map(c => ({
        ...c,
        backorderLineId: '<bo>',
        orderItemId: '<item>',
      }));
    });
    expect(t.out.ok).toHaveLength(2);
    expect(t.state.products.find((p: any) => p.slug === `plain-${fx.k}`)?.inventory).toBe(0);
  });
});

describe.skipIf(!hasDb)('opening balance (seedCoaForStore)', () => {
  it('seeds the chart and posts ONE opening-balance journal from the stock valuation; a re-run changes nothing', async () => {
    const saved = STORE;
    STORE = await newStore();
    try {
      const fx = await fixtures();
      const t = await parity(fx, async () => ({
        first: await seedCoaForStore(STORE),
        again: await seedCoaForStore(STORE),
      }));
      expect(t.out.ok.again).toBe(0);
      expect(t.state.journals).toHaveLength(1);
      // plain 10*100 + v1 3*60 + v2 4*50 (parent cost)
      expect(t.state.journals[0].lines.map((l: any) => l.debit + l.credit)).toEqual([1380, 1380]);
    } finally {
      STORE = saved;
    }
  });
});

describe.skipIf(!hasDb)('barcode scan stock flows (barcode-scan.service)', () => {
  it('receive by a variant barcode moves the variant and records the history row', async () => {
    const fx = await fixtures({ accounts: true });
    const t = await parity(fx, async () => ({
      ok: await receiveByBarcode(STORE, fx.v1Barcode as string, 5, userId, 'dock-1'),
      missing: await settle(() => receiveByBarcode(STORE, '0000000000000', 1, userId)),
    }));
    expect(t.out.ok.ok).toMatchObject({ previousInventory: 3, newInventory: 8 });
  });

  it('a count session: lines upsert, close, reconcile posts the cycle_count adjustment; wrong-state calls are refused', async () => {
    const fx = await fixtures({ accounts: true });
    const t = await parity(fx, async () => {
      const s = await openCountSession(STORE, userId, 'monthly');
      await submitCountLine(STORE, s.id, { productId: fx.plain, countedQty: 8 });
      const second = await submitCountLine(STORE, s.id, { productId: fx.plain, countedQty: 6 });
      await submitCountLine(STORE, s.id, { productId: fx.shirt, variantId: fx.v1, countedQty: 3 });
      const early = await settle(() => reconcileCountSession(STORE, s.id, userId));
      const closed = await closeCountSession(STORE, s.id);
      const late = await settle(() =>
        submitCountLine(STORE, s.id, { productId: fx.plain, countedQty: 1 })
      );
      const again = await settle(() => closeCountSession(STORE, s.id));
      const rec = await reconcileCountSession(STORE, s.id, userId);
      const detail = await getCountSession(STORE, s.id);
      return {
        second: { ...second, id: '<line>', sessionId: '<s>' },
        early,
        closed: closed.status,
        late,
        again,
        rec: { ...rec, adjustmentId: rec.adjustmentId ? '<adj>' : null },
        status: detail?.status,
        lines: detail?.lines.length,
      };
    });
    expect(t.out.ok.second).toMatchObject({ systemQty: 10, variance: -4 });
    expect(t.out.ok.rec).toMatchObject({ linesReconciled: 1, zeroVarianceLines: 1 });
    expect(t.state.sessions[0].status).toBe('reconciled');
  });
});

describe.skipIf(!hasDb)('product bulk update, inventory field (ProductService.bulkUpdate)', () => {
  it('set and adjust apply to simple products only, floor at 0, and variant products are skipped', async () => {
    const fx = await fixtures();
    const t = await parity(fx, async () => ({
      adjust: await ProductService.bulkUpdate(STORE, [fx.plain, fx.shirt], {
        inventory: { mode: 'adjust', value: -50 },
      }),
      set: await ProductService.bulkUpdate(STORE, [fx.plain, fx.shirt], {
        inventory: { mode: 'set', value: 12 },
      }),
    }));
    expect(t.out.ok.set).toEqual({ updated: 1, skippedVariantProducts: 1 });
    expect(t.state.products.find((p: any) => p.slug === `plain-${fx.k}`)?.inventory).toBe(12);
  });
});

describe.skipIf(!hasDb)('COD settlement import (Ruling CF-R7-2)', () => {
  async function shipments(fx: Fx) {
    for (const [i, cod] of [5000, 3000].entries()) {
      const order = await prisma.order.create({
        data: {
          storeId: STORE,
          orderNumber: `R7C-${sfx}-${++n}`,
          subtotal: cod,
          total: cod,
          status: 'confirmed',
          shippingAddress: {},
          billingAddress: {},
        } as never,
      });
      insertSqlite(sqlite, 'Order', [order as Record<string, unknown>]);
      const sh = await prisma.shipment.create({
        data: {
          storeId: STORE,
          orderId: order.id,
          carrier: 'bosta',
          trackingNumber: `R7T${sfx}${n}${i}`,
          status: 'delivered',
          codAmount: cod,
          pickupAddress: {},
          deliveryAddress: {},
        } as never,
      });
      insertSqlite(sqlite, 'Shipment', [sh as Record<string, unknown>]);
      fx.names[sh.id] = `ship${i}`;
      fx[`t${i}`] = sh.trackingNumber;
    }
  }
  const csv = (rows: string[][]) =>
    ['tracking_number,collected,fee,date,reference', ...rows.map(r => r.join(','))].join('\n');
  const svc = () => new CodReconciliationService();

  it('a settlement line matches a DO store shipment, and the report reconciles it', async () => {
    const fx = await fixtures();
    await shipments(fx);
    const t = await parity(fx, async () => {
      const imp = await svc().importSettlement(
        STORE,
        'bosta',
        csv([
          [fx.t0 as string, '50.00', '1.00', '2026-10-01', `L0-${fx.t0}`],
          [fx.t1 as string, '30.00', '0.00', '2026-10-01', `L1-${fx.t1}`],
        ])
      );
      const report = await svc().getReport(STORE);
      return {
        imp,
        rows: report.rows.map(r => ({
          s: r.shipmentId,
          st: r.result.status,
          lines: r.lines.length,
        })),
        summary: report.summary,
      };
    });
    expect(t.out.ok.imp).toMatchObject({ inserted: 2, duplicates: 0, unmatched: 0 });
    expect(t.state.remittances.map((r: any) => r.shipmentId).sort()).toEqual([
      '<ship0>',
      '<ship1>',
    ]);
  });

  it('importing the same file twice changes nothing the second time', async () => {
    const fx = await fixtures();
    await shipments(fx);
    const file = csv([[fx.t0 as string, '50.00', '0.00', '2026-10-02', `D0-${fx.t0}`]]);
    const t = await parity(fx, async () => ({
      first: await svc().importSettlement(STORE, 'bosta', file),
      second: await svc().importSettlement(STORE, 'bosta', file),
    }));
    expect(t.out.ok.first.inserted).toBe(1);
    expect(t.out.ok.second).toMatchObject({ inserted: 0, duplicates: 1 });
    expect(t.state.remittances.filter((r: any) => r.lineRef.startsWith('D0-'))).toHaveLength(1);
  });

  it('a partial match: the known line is matched, the unknown tracking is kept unmatched and shown', async () => {
    const fx = await fixtures();
    await shipments(fx);
    const t = await parity(fx, async () => {
      const imp = await svc().importSettlement(
        STORE,
        'bosta',
        csv([
          [fx.t0 as string, '20.00', '0.00', '2026-10-03', `P0-${fx.t0}`],
          ['NO-SUCH-TRACKING', '9.00', '0.00', '2026-10-03', `P9-${fx.t0}`],
        ])
      );
      const report = await svc().getReport(STORE, { carrier: 'bosta' });
      return {
        imp,
        unmatched: report.unmatched.map(u => ({ t: u.trackingNumber, net: u.netAmount })),
        partial: report.rows.filter(r => r.result.status === 'partial').length,
      };
    });
    expect(t.out.ok.imp).toMatchObject({ inserted: 2, unmatched: 1 });
    expect(t.out.ok.unmatched).toEqual([{ t: 'NO-SUCH-TRACKING', net: 900 }]);
  });
});
