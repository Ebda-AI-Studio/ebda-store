/**
 * INFRA-CF-1 PR D2b-3 (Rulings CF-PAY-1, CF-LEDGER-1): the ledger, refund-by-status and gold repricing moved to the StoreDO give
 * the same answer and leave the same rows on Postgres and on the DO. Each test is a SCENARIO driving the real service; it runs
 * once on Postgres (unchanged code) and once with the DO money client over the real DO schema on SQLite (real wire codec,
 * `answerMoneyOp`, `runMoneyOp`). Each backend gets its own identical world (mirrored into SQLite); the scrubbed traces
 * (return values or error, then the ledger / order / stock / price rows) must be equal. Trial balance parity is asserted
 * per account code.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { prisma, runInTenantContext } from '@ebda/database';
import {
  answerMoneyOp,
  decodeRpc,
  encodeRpc,
  ensureMoneyOpsSchema,
  createDoClient,
  createPrismaLite,
  ensureIdempotencySchema,
  runReads,
  runWrites,
} from '@ebda-src/repo';
import { OrderService } from '../../apps/api/src/services/order.service';
import { featureService } from '../../apps/api/src/services/feature.service';
import { handleOrderRefunded } from '../../apps/api/src/lib/inngest/functions/order-refunded';
import {
  makeMoneyClient,
  storeDb,
  storeMoney,
  withRepo,
  type StoreReads,
  type StoreWrites,
} from '../../apps/api/src/lib/repo-factory';
import { AppError } from '../../apps/api/src/middleware/error-handler';
import { seedCoaForStore } from '../../apps/api/src/services/accounting/account.service';
import { postOrderPaymentJournal } from '../../apps/api/src/services/accounting/posting/order-posting';
import { postRefundJournal } from '../../apps/api/src/services/accounting/posting/refund-posting';
import { GoldRateService } from '../../apps/api/src/services/gold-rate/gold-rate.service';
import { META, canon, insertSqlite, openSqlite } from '../../packages/repo/test/diff-harness';
import { nodeSqlRunner } from '../../packages/repo/test/node-sql';
import { nodeSyncSql } from '../../packages/repo/test/node-sync-sql';
import { hasDb } from '../helpers/bundle-fixtures';
import { createProduct, ownerPool } from '../helpers/gold-sql';

const sfx = Date.now().toString(36);
let STORE = '';
let ownerId = '';
const sqlite = openSqlite();
const ownerPg = ownerPool();

function doRepo() {
  const sql = nodeSqlRunner(sqlite);
  ensureIdempotencySchema(sql);
  const sync = nodeSyncSql(sqlite);
  ensureMoneyOpsSchema(sync);
  const lite = createPrismaLite(META as never, sql, 'store-do', {
    storeId: STORE,
  }) as never;
  const c = createDoClient(
    q => runReads(lite, q),
    m => runWrites(lite, sql, m)
  ) as never;
  const money = makeMoneyClient(async (op, args, key) => {
    const r = answerMoneyOp(sync, STORE, op, encodeRpc(args), key);
    if (!r.ok) throw new AppError(r.status, r.code, r.message);
    return decodeRpc(r.json);
  });
  return {
    storeId: STORE,
    backend: 'do' as const,
    db: c as StoreReads,
    writer: c as StoreWrites,
    money,
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
function scrub(v: unknown, names: Record<string, string>): unknown {
  let text = JSON.stringify(canon(v)) ?? 'null';
  for (const [id, name] of Object.entries(names)) text = text.split(id).join(`<${name}>`);
  return JSON.parse(
    text
      .replace(UUID, '<id>')
      .replace(/(JE|ORD|PAID)-[A-Z0-9-]+/g, '<no>')
      .replace(/"\d{4}-\d\d-\d\dT[\d:.]+Z"/g, '"<date>"')
  );
}
const settle = async <T>(f: () => Promise<T>) =>
  f().then(
    v => ({ ok: v }),
    (e: { code?: string; statusCode?: number; message?: string }) => ({
      err: {
        status: e.statusCode,
        code: e.code,
        message: e.code ? undefined : String(e.message).slice(0, 120),
      },
    })
  );

let n = 0;
interface World {
  order: string;
  product: string;
  names: Record<string, string>;
}
/** A paid, confirmed order of 3 x 1000 with cost 400, one completed paymob payment, mirrored into the DO. */
async function paidWorld(mirror: boolean, opts: { wallet?: number } = {}): Promise<World> {
  const k = `${sfx}${++n}`;
  const product = await prisma.product.create({
    data: {
      storeId: STORE,
      name: 'Tee',
      slug: `tee-${k}`,
      price: 1_000,
      status: 'active',
      inventory: 17,
      trackInventory: true,
      costPrice: 400,
    },
  });
  const total = 3_000;
  const order = await prisma.order.create({
    data: {
      storeId: STORE,
      orderNumber: `PAID-${k}`,
      status: 'confirmed',
      paymentStatus: 'paid',
      subtotal: total,
      tax: 0,
      shipping: 0,
      discount: 0,
      total,
      walletAmount: opts.wallet ?? 0,
      currency: 'EGP',
      shippingAddress: {},
      billingAddress: {},
      items: {
        create: [
          {
            productId: product.id,
            productName: 'Tee',
            quantity: 3,
            price: 1_000,
            total,
            costPrice: 400,
          },
        ],
      },
    },
    include: { items: true },
  });
  const payment = await prisma.payment.create({
    data: {
      orderId: order.id,
      provider: 'paymob',
      status: 'completed',
      amount: total,
      currency: 'EGP',
      transactionId: `tx-${k}`,
    },
  });
  if (mirror) {
    insertSqlite(sqlite, 'Product', [product] as never);
    const { items, ...o } = order;
    insertSqlite(sqlite, 'Order', [o] as never);
    insertSqlite(sqlite, 'OrderItem', items as never);
    insertSqlite(sqlite, 'Payment', [payment] as never);
  }
  return {
    order: order.id,
    product: product.id,
    names: { [order.id]: 'order', [product.id]: 'product' },
  };
}

/** Per-account debit / credit totals of the store's ledger, through whichever backend is current. */
async function ledger() {
  const db = (await storeDb(STORE)) as never as {
    journalEntry: {
      findMany(
        a: unknown
      ): Promise<Array<{ status: string; source: string; sourceId: string | null }>>;
    };
    journalLine: {
      findMany(a: unknown): Promise<Array<{ debit: number; credit: number; accountId: string }>>;
    };
    account: { findMany(a: unknown): Promise<Array<{ id: string; code: string }>> };
  };
  const accounts = await db.account.findMany({
    where: { storeId: STORE },
    select: { id: true, code: true },
  });
  const code = new Map(accounts.map(a => [a.id, a.code]));
  const entries = await db.journalEntry.findMany({
    where: { storeId: STORE },
    select: { status: true, source: true, sourceId: true },
  });
  const lines = await db.journalLine.findMany({
    where: { entry: { storeId: STORE } },
    select: { debit: true, credit: true, accountId: true },
  });
  const by: Record<string, { debit: number; credit: number }> = {};
  for (const l of lines) {
    const c = code.get(l.accountId) ?? '?';
    by[c] = { debit: (by[c]?.debit ?? 0) + l.debit, credit: (by[c]?.credit ?? 0) + l.credit };
  }
  return {
    trial: Object.fromEntries(Object.entries(by).sort(([a], [b]) => a.localeCompare(b))),
    balanced:
      Object.values(by).reduce((s, x) => s + x.debit, 0) ===
      Object.values(by).reduce((s, x) => s + x.credit, 0),
    entries: entries
      .map(e => `${e.source}:${(e.sourceId ?? '').replace(/[0-9a-f-]{36}/g, '<id>')}:${e.status}`)
      .sort(),
  };
}
async function orderState(w: World) {
  const db = (await storeDb(STORE)) as never as {
    order: { findFirst(a: unknown): Promise<unknown> };
    product: { findFirst(a: unknown): Promise<unknown> };
  };
  return {
    order: await db.order.findFirst({
      where: { id: w.order },
      select: { status: true, paymentStatus: true },
    }),
    product: await db.product.findFirst({ where: { id: w.product }, select: { inventory: true } }),
  };
}
async function parity(
  make: (mirror: boolean) => Promise<World>,
  act: (w: World) => Promise<unknown>,
  read: (w: World) => Promise<unknown>
) {
  const run = async (on: typeof onPg, mirror: boolean) => {
    const w = await make(mirror);
    const out = await settle(() => on(() => act(w)));
    return scrub({ out, state: await on(() => read(w)) }, w.names);
  };
  const pg = await run(onPg, false);
  const dobj = await run(onDo, true);
  expect(dobj).toEqual(pg);
  return pg as any;
}
const inStore = <T>(f: () => Promise<T>) => runInTenantContext(STORE, f);
const inlineStep = { run: <T>(_id: string, fn: () => Promise<T>) => fn() };

beforeAll(async () => {
  const owner = await prisma.user.create({
    data: {
      email: `d2b3-${sfx}@example.test`,
      passwordHash: 'x'.repeat(60),
      firstName: 'D',
      lastName: 'B',
      role: 'store_admin',
      status: 'active',
      emailVerified: true,
    },
  });
  ownerId = owner.id;
  STORE = (
    await prisma.store.create({
      data: { name: 'D2b3', slug: `d2b3-${sfx}`, ownerId: owner.id, status: 'active' },
    })
  ).id;
  await seedCoaForStore(STORE);
  const accounts = await prisma.account.findMany({ where: { storeId: STORE } });
  insertSqlite(sqlite, 'Account', accounts as never);
  sqlite
    .prepare('INSERT OR REPLACE INTO store_config (store_id, accounting_enabled) VALUES (?, 1)')
    .run(STORE);
});
beforeEach(() => {
  vi.spyOn(featureService, 'isFeatureEnabled').mockResolvedValue(false);
});
afterAll(async () => {
  vi.restoreAllMocks();
  await ownerPg.end();
  await prisma.$disconnect();
});

describe.skipIf(!hasDb)('ledger, refunds and gold repricing on Postgres vs the DO', () => {
  it('trial balance parity: a paid order posts sale + COGS, a refund reverses both, the book nets to zero', async () => {
    const t = await parity(
      paidWorld,
      async w => {
        await inStore(() => postOrderPaymentJournal({ orderId: w.order }));
        await inStore(() => postOrderPaymentJournal({ orderId: w.order })); // replay posts nothing
        const mid = await ledger();
        await postRefundJournal({ orderId: w.order, storeId: STORE });
        await postRefundJournal({ orderId: w.order, storeId: STORE });
        return { mid };
      },
      ledger
    );
    expect(t.out.ok.mid.balanced).toBe(true);
    expect(t.state.balanced).toBe(true);
    // netted to zero per account
    for (const v of Object.values(t.state.trial) as Array<{ debit: number; credit: number }>)
      expect(v.debit).toBe(v.credit);
  });

  it('refund by status: the order is refunded, the stock comes back once, a second refund changes nothing', async () => {
    const t = await parity(
      paidWorld,
      async w => {
        await OrderService.updateStatus(STORE, w.order, 'refunded');
        // Postgres reverses in the order/refunded fanout (the DO already did, in the refund section): run it inline
        if ((await storeMoney(STORE)) === null)
          await handleOrderRefunded(w.order, STORE, true, false, inlineStep);
        await OrderService.updateStatus(STORE, w.order, 'refunded').catch(() => undefined);
        return 'done';
      },
      orderState
    );
    expect(t.state.order.status).toBe('refunded');
    expect(t.state.product.inventory).toBe(20);
  });

  it('gold repricing: a new rate re-prices the gold product the same way on both backends', async () => {
    const make = async (mirror: boolean): Promise<World> => {
      const id = await createProduct(ownerPg, STORE, {
        mode: 'gold_rate',
        karat: 21,
        weightMg: 3250,
        makingType: 'per_gram',
        makingValue: 15_000,
        price: 1,
        slug: `gold-${sfx}-${++n}`,
      });
      await GoldRateService.applyRates(
        STORE,
        { rates: [{ karat: 21, ratePerGram: 576_000 }], confirm: true },
        { userId: ownerId }
      );
      const product = await prisma.product.findUniqueOrThrow({ where: { id } });
      if (mirror) {
        const rates = await prisma.goldRate.findMany({ where: { storeId: STORE } });
        const current = await prisma.goldRateCurrent.findMany({ where: { storeId: STORE } });
        sqlite.exec('DELETE FROM gold_rates_current; DELETE FROM gold_rates');
        insertSqlite(sqlite, 'GoldRate', rates as never);
        insertSqlite(sqlite, 'GoldRateCurrent', current as never);
        insertSqlite(sqlite, 'Product', [product] as never);
      }
      return { order: '', product: id, names: { [id]: 'product' } };
    };
    const t = await parity(
      make,
      async () => {
        const out = await GoldRateService.applyRates(
          STORE,
          { rates: [{ karat: 21, ratePerGram: 578_000 }], confirm: true },
          { userId: ownerId }
        );
        return { applied: out.applied.length, pending: out.pending.length, repriced: out.repriced };
      },
      async w => {
        const db = (await storeDb(STORE)) as never as {
          product: { findFirst(a: unknown): Promise<unknown> };
        };
        return db.product.findFirst({ where: { id: w.product }, select: { price: true } });
      }
    );
    expect(t.out.ok).toMatchObject({ applied: 1, pending: 0, repriced: 1 });
    expect(t.state.price).toBeGreaterThan(1);
  });
});
