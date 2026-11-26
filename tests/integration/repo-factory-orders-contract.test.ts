/**
 * INFRA-CF-1 PR D2b-2 (Ruling CF-ORDERS-1): order creation and cancellation moved to the StoreDO give the same answer and
 * leave the same rows on Postgres and on the DO. Each test is a SCENARIO driving the real `OrderService`; it runs once on
 * Postgres (the unchanged code, real transaction) and once with the DO money client over the real DO schema on SQLite (the
 * real wire codec, `answerMoneyOp`, `runMoneyOp`). Each backend gets its own identical world (the DO's copy is mirrored into
 * SQLite); the scrubbed traces (return values or error status, then the order, stock, coupon and ledger rows) must be equal.
 * Cancel: Postgres reverses through the `order/refunded` fanout (run inline here), the DO inside the one section.
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
  ensureSearchIndex,
  runReads,
  runWrites,
} from '@ebda-src/repo';
import { OrderService } from '../../apps/api/src/services/order.service';
import { CartService } from '../../apps/api/src/services/cart.service';
import { featureService } from '../../apps/api/src/services/feature.service';
import { handleOrderRefunded } from '../../apps/api/src/lib/inngest/functions/order-refunded';
import {
  makeMoneyClient,
  storeMoney,
  storeWriter,
  withRepo,
  type StoreReads,
  type StoreWrites,
} from '../../apps/api/src/lib/repo-factory';
import { AppError } from '../../apps/api/src/middleware/error-handler';
import { META, canon, insertSqlite, openSqlite } from '../../packages/repo/test/diff-harness';
import { nodeSqlRunner } from '../../packages/repo/test/node-sql';
import { nodeSyncSql } from '../../packages/repo/test/node-sync-sql';
import { cartSessionId, hasDb } from '../helpers/bundle-fixtures';
import { GoldRateService } from '../../apps/api/src/services/gold-rate/gold-rate.service';
import { InstapayService } from '../../apps/api/src/services/payment-providers/instapay.service';
import { OWNER_URL, createProduct, ownerPool } from '../helpers/gold-sql';
import { reportAndEndStaleTransactions } from '../helpers/teardown-diagnostics';
import { withPgStoreDelegate } from '../helpers/do-store-delegate';

const sfx = Date.now().toString(36);
let STORE = '';
let ownerId = '';
const sqlite = openSqlite();

function doRepo() {
  const sql = nodeSqlRunner(sqlite);
  ensureIdempotencySchema(sql);
  const sync = nodeSyncSql(sqlite);
  ensureMoneyOpsSchema(sync);
  ensureSearchIndex(sync);
  const lite = createPrismaLite(META as never, sql, 'store-do', { storeId: STORE }) as never;
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
    db: withPgStoreDelegate(c) as StoreReads,
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
      .replace(/ORD-[A-Z0-9-]+/g, '<no>')
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

interface World {
  product: string;
  coupon: string;
  names: Record<string, string>;
}
let n = 0;
async function world(stock: number, mirror: boolean): Promise<World> {
  const k = `${sfx}${++n}`;
  const product = await prisma.product.create({
    data: {
      storeId: STORE,
      name: 'Tee',
      slug: `tee-${k}`,
      price: 10_000,
      status: 'active',
      inventory: stock,
      trackInventory: true,
    },
  });
  const coupon = await prisma.coupon.create({
    data: {
      storeId: STORE,
      code: `C${k}`.toUpperCase(),
      name: 'c',
      type: 'fixed',
      value: 1_000,
      usageLimit: 2,
      isActive: true,
    },
  });
  if (mirror) {
    insertSqlite(sqlite, 'Product', [product] as never);
    insertSqlite(sqlite, 'Coupon', [coupon] as never);
  }
  return {
    product: product.id,
    coupon: coupon.code,
    names: { [product.id]: 'product', [coupon.id]: 'coupon', [coupon.code]: 'code' },
  };
}
let phoneSeq = 0;
const address = (i: number) => ({
  firstName: 'Mona',
  lastName: 'Adel',
  address1: 'Nasr City',
  city: 'Cairo',
  state: 'Cairo',
  postalCode: '',
  country: 'Egypt',
  phone: `+2010${(3_000_000 + i + 1000 * phoneSeq).toString().slice(-7)}`,
});
async function place(w: World, qty: number, extra: Record<string, unknown> = {}, i = 1) {
  const sessionId = cartSessionId('d2b2');
  const cart = await CartService.getOrCreate(STORE, sessionId, undefined);
  await (
    await storeWriter(STORE)
  ).cartItem.create({ data: { cartId: cart.id, productId: w.product, quantity: qty } });
  const o = await OrderService.create(
    STORE,
    undefined,
    sessionId,
    { shippingAddress: address(i), paymentMethod: 'cod', ...extra } as never,
    undefined,
    undefined
  );
  return o;
}
const inlineStep = { run: <T>(_id: string, fn: () => Promise<T>) => fn() };

/** The rows that matter, read through whichever backend is current, in a backend-neutral shape. */
async function state(w: World) {
  const { storeDb } = await import('../../apps/api/src/lib/repo-factory');
  const db = (await storeDb(STORE)) as any;
  const products = await db.product.findMany({
    where: { id: w.product },
    select: { inventory: true },
  });
  const coupons = await db.coupon.findMany({
    where: { code: w.coupon, storeId: STORE },
    select: { usageCount: true },
  });
  const orders = await db.order.findMany({
    where: { storeId: STORE, items: { some: { productId: w.product } } },
    select: {
      status: true,
      paymentStatus: true,
      subtotal: true,
      discount: true,
      couponDiscount: true,
      shipping: true,
      tax: true,
      total: true,
      couponCode: true,
      notes: true,
      locale: true,
      smsOptIn: true,
      source: true,
      items: { select: { quantity: true, price: true, total: true } },
    },
  });
  const history = await db.inventoryHistory.findMany({
    where: { productId: w.product },
    select: { type: true, quantity: true, previousStock: true, newStock: true },
  });
  // PR R2 (Ruling CF-R2-1): the fiscal documents of those orders (number, serial, amounts, payload) and the cart rows left
  // behind are part of every scenario's trace, so every order scenario also proves the gapless numbering and the cart claim.
  const orderIds = (
    await db.order.findMany({
      where: { storeId: STORE, items: { some: { productId: w.product } } },
      select: { id: true },
    })
  ).map((o: { id: string }) => o.id);
  const fiscal = await db.fiscalDocument.findMany({
    where: { storeId: STORE, orderId: { in: orderIds } },
    select: {
      docType: true,
      serial: true,
      number: true,
      status: true,
      currency: true,
      netAmount: true,
      vatAmount: true,
      totalAmount: true,
      vatRateBps: true,
      sellerTrn: true,
      refundRef: true,
      originalNumber: true,
      payload: true,
    },
  });
  const counters = await db.fiscalDocument.count({ where: { storeId: STORE } });
  const cartItems = await db.cartItem.count({ where: { cart: { storeId: STORE } } });
  const key = (r: unknown) => JSON.stringify(r);
  return {
    fiscal: fiscal.sort((a: any, b: any) => key(a).localeCompare(key(b))),
    documentsInStore: counters,
    cartItems,
    products,
    coupons,
    orders: orders.sort((a: any, b: any) => key(a).localeCompare(key(b))),
    history: history.sort((a: any, b: any) => key(a).localeCompare(key(b))),
  };
}

/** Both backends run the scenario in their own identical world; the scrubbed traces must be equal. */
async function parity(stock: number, scenario: (w: World) => Promise<unknown>) {
  phoneSeq++; // both runs use the same phones, a new set per scenario
  const run = async (on: typeof onPg, mirror: boolean) => {
    const w = await world(stock, mirror);
    const out = await settle(() => on(() => scenario(w)));
    return scrub({ out, state: await on(() => state(w)) }, w.names);
  };
  const pg = await run(onPg, false);
  const dobj = await run(onDo, true);
  expect(dobj).toEqual(pg);
  if (process.env.DEBUG_PARITY) console.log(JSON.stringify((pg as any).out));
  return pg as any;
}

beforeAll(async () => {
  const owner = await prisma.user.create({
    data: {
      email: `d2b2-${sfx}@example.test`,
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
      data: { name: 'D2b2', slug: `d2b2-${sfx}`, ownerId: owner.id, status: 'active' },
    })
  ).id;
  // the DO's copy of the store's settings: the sale document reads its seller (name, address, phone, email) from it
  sqlite
    .prepare(
      `INSERT OR REPLACE INTO store_profile (store_id, name, slug, owner_id) VALUES (?, 'D2b2', ?, ?)`
    )
    .run(STORE, `d2b2-${sfx}`, owner.id);
  await prisma.paymentConfig.create({
    data: {
      storeId: STORE,
      provider: 'cod',
      isEnabled: true,
      fixedFee: 0,
      settings: { percentBps: 0 },
    },
  });
});
beforeEach(() => {
  vi.spyOn(featureService, 'isFeatureEnabled').mockResolvedValue(false);
});
// Teardown only closes connections and takes milliseconds when nothing is left open (measured: ownerPg.end 0 ms,
// prisma.$disconnect 1-2 ms, against Postgres 17 locally, alone and inside the full tier, node 22 and 26). On the hosted runner
// it hung for 30 s and then 90 s (PR 437 runs 42051542716, 42056044397) with every test green, and `pool.end()` /
// `$disconnect()` wait for exactly one thing: a connection that is still checked out, i.e. a transaction that never finished.
// So after 8 s the hook names it (pool counters and the live pg_stat_activity rows, from a fresh connection) and ends any
// backend left inside an open transaction doing nothing, then lets the close finish; the evidence lands in the CI log.
afterAll(async () => {
  vi.restoreAllMocks();
  const timer = setTimeout(() => {
    reportAndEndStaleTransactions(OWNER_URL, ownerPg).then(
      r => console.error('[orders-contract teardown] still closing after 8 s; open work:', r),
      e => console.error('[orders-contract teardown] could not inspect pg_stat_activity:', e)
    );
  }, 8_000);
  // CI run 42067641601 named it: an `idle in transaction` BEGIN left by Prisma's driver adapter when startTransaction
  // failed with "Unknown transaction status" under the concurrent-submit case (noteOrderCreated, logged and swallowed).
  // Ending that backend frees Postgres, but Prisma still counts the lost client, so $disconnect would wait forever:
  // bound it at 20 s and say so. Ruling NZ-TEARDOWN-DIAG-1; the adapter defect is tracked, not hidden.
  const settle = (p: Promise<unknown>, what: string) =>
    Promise.race([
      p,
      new Promise(resolve =>
        setTimeout(() => {
          console.error(`[orders-contract teardown] ${what} did not finish in 20 s; moving on`);
          resolve(undefined);
        }, 20_000)
      ),
    ]);
  try {
    await Promise.all([
      settle(ownerPg.end(), 'ownerPg.end'),
      settle(prisma.$disconnect(), 'prisma.$disconnect'),
    ]);
  } finally {
    clearTimeout(timer);
  }
});

/** Gold: a product priced by rate (raw SQL, the price guard needs it) mirrored into the DO, and the store's rates mirrored. */
const ownerPg = ownerPool();
async function mirrorRates() {
  const rates = await prisma.goldRate.findMany({ where: { storeId: STORE } });
  const current = await prisma.goldRateCurrent.findMany({ where: { storeId: STORE } });
  sqlite.exec('DELETE FROM gold_rates_current; DELETE FROM gold_rates');
  insertSqlite(sqlite, 'GoldRate', rates as never);
  insertSqlite(sqlite, 'GoldRateCurrent', current as never);
}
let rateNo = 576_000;
const applyRate = async () => {
  // the world is built on Postgres and then mirrored: the rate write itself must stay on Postgres here, not follow the DO
  // repo of the scenario that is running (GoldRateService.applyRates follows the store's backend since CF-PAY-1)
  await onPg(() =>
    GoldRateService.applyRates(
      STORE,
      { rates: [{ karat: 21, ratePerGram: rateNo }], confirm: true },
      { userId: ownerId }
    )
  );
  await mirrorRates();
};
const moveRate = async () => {
  rateNo += 1000;
  await applyRate();
};
async function goldWorld(mirror: boolean): Promise<World> {
  // The gold cases pay by COD, so the store opts in to deferred payment for gold (Ruling SHARIA-GOLD-1), on BOTH backends:
  // Postgres reads stores.settings, the DO checkout reads store_config.settings.
  await prisma.$executeRaw`update stores set settings = coalesce(settings, '{}'::jsonb) || '{"goldAllowDeferredPayment": true}'::jsonb where id = ${STORE}`;
  if (mirror)
    sqlite.exec(
      // accounting_enabled = 0 so a NEW row reads exactly like the missing one (the DO ledger treats no row as accounting off)
      `INSERT INTO store_config (store_id, settings, accounting_enabled) VALUES ('${STORE}', '{"goldAllowDeferredPayment":true}', 0)
       ON CONFLICT(store_id) DO UPDATE SET settings = json_set(settings, '$.goldAllowDeferredPayment', json('true'))`
    );
  const id = await createProduct(ownerPg, STORE, {
    mode: 'gold_rate',
    karat: 21,
    weightMg: 3250,
    makingType: 'per_gram',
    makingValue: 15_000,
    price: 1,
    slug: `gold-${sfx}-${++n}`,
  });
  await applyRate(); // the repricer sets the materialised price on every gold product, at the CURRENT rate
  const product = await prisma.product.findUniqueOrThrow({ where: { id } });
  if (mirror) insertSqlite(sqlite, 'Product', [product] as never);
  return { product: id, coupon: 'NONE', names: { [id]: 'product' } };
}
async function placeGold(w: World, move: boolean) {
  const sessionId = cartSessionId('d2b2g');
  await CartService.addItem(STORE, sessionId, w.product, 1);
  if (move) {
    await moveRate(); // the rate moves after the shopper saw the price
    const p = await prisma.product.findUniqueOrThrow({ where: { id: w.product } });
    sqlite.prepare('UPDATE products SET price = ? WHERE id = ?').run(p.price, w.product);
  }
  return OrderService.create(
    STORE,
    undefined,
    sessionId,
    { shippingAddress: address(1), paymentMethod: 'cod' } as never,
    undefined,
    undefined
  );
}
async function parityWith(
  make: (mirror: boolean) => Promise<World>,
  scenario: (w: World) => Promise<unknown>
) {
  phoneSeq++;
  const run = async (on: typeof onPg, mirror: boolean) => {
    const w = await make(mirror);
    const out = await settle(() => on(() => scenario(w)));
    return scrub({ out, state: await on(() => state(w)) }, w.names);
  };
  const pg = await run(onPg, false);
  const dobj = await run(onDo, true);
  expect(dobj).toEqual(pg);
  return pg as any;
}

/** An InstaPay order awaiting the merchant: window already closed, optionally with the shopper's reference (proof). */
async function instapayWorld(mirror: boolean, proof: boolean, windowMs: number) {
  const k = `${sfx}${++n}`;
  const order = await prisma.order.create({
    data: {
      storeId: STORE,
      orderNumber: `IP-${k}`,
      status: 'awaiting_payment_confirmation',
      paymentStatus: 'unpaid',
      subtotal: 5_000,
      tax: 0,
      shipping: 0,
      discount: 0,
      total: 5_000,
      currency: 'EGP',
      shippingAddress: {},
      billingAddress: {},
      paymentConfirmationExpiresAt: new Date(Date.now() + windowMs),
    },
  });
  const payment = await prisma.payment.create({
    data: {
      orderId: order.id,
      provider: 'instapay',
      status: 'pending',
      amount: 5_000,
      currency: 'EGP',
      metadata: proof ? { customerReference: 'REF123' } : {},
    },
  });
  if (mirror) {
    insertSqlite(sqlite, 'Order', [order] as never);
    insertSqlite(sqlite, 'Payment', [payment] as never);
  }
  return { order: order.id, payment: payment.id };
}
async function instapayState(order: string) {
  const { storeDb } = await import('../../apps/api/src/lib/repo-factory');
  const db = (await storeDb(STORE)) as any;
  return {
    order: await db.order.findFirst({
      where: { id: order },
      select: { status: true, paymentStatus: true },
    }),
    payments: await db.payment.findMany({ where: { orderId: order }, select: { status: true } }),
  };
}
async function instapayParity(
  proof: boolean,
  windowMs: number,
  act: (o: string) => Promise<unknown>
) {
  const run = async (on: typeof onPg, mirror: boolean) => {
    const w = await instapayWorld(mirror, proof, windowMs);
    const out = await settle(() => on(() => act(w.order)));
    return scrub(
      { out, state: await on(() => instapayState(w.order)) },
      { [w.order]: 'order', [w.payment]: 'payment' }
    );
  };
  const pg = await run(onPg, false);
  const dobj = await run(onDo, true);
  expect(dobj).toEqual(pg);
  return pg as any;
}

describe.skipIf(!hasDb)('orders (OrderService) on Postgres vs the DO', () => {
  it('instapay expiry: a closed window with NO proof expires; with the shopper reference it is skipped (audit O1)', async () => {
    const expired = await instapayParity(false, -60_000, o => InstapayService.expireOne(STORE, o));
    expect(expired.out.ok).toBe('expired');
    expect(expired.state.order.status).toBe('cancelled');
    expect(expired.state.payments).toEqual([{ status: 'expired' }]);
    const kept = await instapayParity(true, -60_000, o => InstapayService.expireOne(STORE, o));
    expect(kept.out.ok).toBe('skipped');
    expect(kept.state.order.status).toBe('awaiting_payment_confirmation');
    // an open window is never expired
    const open = await instapayParity(false, 3_600_000, o => InstapayService.expireOne(STORE, o));
    expect(open.out.ok).toBe('skipped');
  });

  it('instapay confirm: once, a second tap changes nothing; past the window only with proof', async () => {
    const t = await instapayParity(false, 3_600_000, async o => ({
      first: await InstapayService.confirm({ storeId: STORE, orderId: o, actorUserId: ownerId }),
      second: await InstapayService.confirm({ storeId: STORE, orderId: o, actorUserId: ownerId }),
    }));
    expect(t.out.ok.first.changed).toBe(true);
    expect(t.out.ok.second.changed).toBe(false);
    expect(t.state.payments).toEqual([{ status: 'completed' }]);
    const late = await instapayParity(false, -60_000, o =>
      InstapayService.confirm({ storeId: STORE, orderId: o, actorUserId: ownerId })
    );
    expect(late.out.err).toMatchObject({ status: 409, code: 'INSTAPAY_CONFIRMATION_EXPIRED' });
    const lateProof = await instapayParity(true, -60_000, o =>
      InstapayService.confirm({ storeId: STORE, orderId: o, actorUserId: ownerId })
    );
    expect(lateProof.out.ok.changed).toBe(true);
  });

  it('gold: a rate that moved after the shopper saw the price is refused PRICE_CHANGED and writes nothing', async () => {
    await moveRate();
    const t = await parityWith(goldWorld, w => placeGold(w, true));
    expect(t.out.err).toMatchObject({ status: 409, code: 'PRICE_CHANGED' });
    expect(t.state.orders).toEqual([]);
    expect(t.state.products[0].inventory).toBe(5);
  });

  it('gold: an unchanged rate prices the order from the rate on both backends', async () => {
    await moveRate();
    const t = await parityWith(goldWorld, w => placeGold(w, false));
    expect(t.state.orders).toHaveLength(1);
    expect(t.state.products[0].inventory).toBe(4);
  });

  it('options the order service stamps: notes, locale, sms opt-in, source are the same', async () => {
    const t = await parity(10, w =>
      place(w, 1, { notes: 'ring twice', locale: 'ar', smsOptIn: true, source: 'agent' })
    );
    expect(t.state.orders[0]).toMatchObject({
      notes: 'ring twice',
      locale: 'ar',
      smsOptIn: true,
      source: 'agent',
    });
  });

  it('cancel with restoreInventory:false: goods stay out of stock, the coupon use still comes back', async () => {
    const t = await parity(10, async w => {
      const o = (await place(w, 4, { couponCode: w.coupon })) as { id: string };
      await OrderService.updateStatus(STORE, o.id, 'cancelled', { restoreInventory: false });
      if ((await (await import('../../apps/api/src/lib/repo-factory')).storeMoney(STORE)) === null)
        await handleOrderRefunded(o.id, STORE, false, false, inlineStep);
      return 'done';
    });
    expect(t.state.products[0].inventory).toBe(6);
    expect(t.state.coupons[0].usageCount).toBe(0);
    expect(t.state.orders[0].status).toBe('cancelled');
  });

  it('fiscal: each order gets one receipt with the next gapless number; the document and its payload are the same on both backends', async () => {
    const t = await parity(20, async w => {
      await place(w, 2, { couponCode: w.coupon }, 1); // a discount line in the payload
      await place(w, 1, {}, 2);
      await place(w, 99, {}, 3).catch(() => undefined); // refused: burns no number
      return place(w, 1, {}, 4);
    });
    expect(t.state.fiscal.map((d: any) => d.docType)).toEqual(['receipt', 'receipt', 'receipt']);
    const serials = t.state.fiscal.map((d: any) => d.serial).sort((a: number, b: number) => a - b);
    expect(serials.slice(1).every((x: number, i: number) => x === serials[i] + 1)).toBe(true); // no gap
    expect(t.state.fiscal[0].payload.lines[0].kind).toBe('item');
  });

  it('fiscal: an unpaid order that is cancelled keeps its number, marked cancelled; the next order takes the next number', async () => {
    const t = await parity(10, async w => {
      const o = (await place(w, 1, {}, 1)) as { id: string };
      await OrderService.updateStatus(STORE, o.id, 'cancelled');
      if ((await (await import('../../apps/api/src/lib/repo-factory')).storeMoney(STORE)) === null)
        await handleOrderRefunded(o.id, STORE, true, false, inlineStep);
      return place(w, 1, {}, 2);
    });
    expect(t.state.fiscal.map((d: any) => d.status).sort()).toEqual(['cancelled', 'issued']);
  });

  it('fiscal: partial refunds get credit notes keyed on the refund, capped at what is left; a replay issues nothing', async () => {
    const t = await parity(10, async w => {
      const o = (await place(w, 1, {}, 1)) as { id: string };
      const refund = async (refundKey: string, refundAmount: number) => {
        const partial = { items: [], refundKey, refundAmount, amountOnly: true };
        if (
          (await (await import('../../apps/api/src/lib/repo-factory')).storeMoney(STORE)) === null
        )
          await handleOrderRefunded(o.id, STORE, false, false, inlineStep, partial);
        else
          await OrderService.applyRefundEffects(STORE, o.id, {
            restoreInventory: false,
            fireRefundNotification: false,
            partial,
          });
      };
      await refund('refund:a', 3_000);
      await refund('refund:a', 3_000); // the same refund again
      await refund('refund:b', 99_999_999); // more than is left: capped
      await refund('refund:c', 100); // nothing left
      return 'done';
    });
    const credits = t.state.fiscal.filter((d: any) => d.docType === 'refund_receipt');
    expect(credits).toHaveLength(2);
    expect(credits.reduce((n: number, d: any) => n + d.totalAmount, 0)).toBe(10_000);
  });

  it('fiscal: with a verified VAT profile the sale is a TAX INVOICE naming the buyer, VAT-exclusive and VAT-inclusive; its credit notes sum to it', async () => {
    const withTax = async (included: boolean) => {
      await prisma.store.update({
        where: { id: STORE },
        data: { taxEnabled: true, taxIncludedInPrice: included },
      });
      const profile = await prisma.storeTaxProfile.create({
        data: {
          storeId: STORE,
          status: 'verified',
          taxRegistrationNumber: '100200300',
          legalName: 'D2b2 LLC',
        },
      });
      const rate = await prisma.taxRate.create({
        data: { storeId: STORE, name: 'VAT', rate: 14, isActive: true },
      });
      sqlite.exec(
        `DELETE FROM store_config WHERE store_id = '${STORE}';
         INSERT INTO store_config (store_id, tax_enabled, tax_included_in_price) VALUES ('${STORE}', 1, ${included ? 1 : 0});
         INSERT INTO store_tax_profiles (id, store_id, status, tax_registration_number, legal_name) VALUES ('${profile.id}', '${STORE}', 'verified', '100200300', 'D2b2 LLC');
         INSERT INTO tax_rates (id, store_id, name, rate, is_active) VALUES ('${rate.id}', '${STORE}', 'VAT', 1400, 1);`
      );
      return async () => {
        await prisma.taxRate.delete({ where: { id: rate.id } });
        await prisma.storeTaxProfile.delete({ where: { id: profile.id } });
        await prisma.store.update({
          where: { id: STORE },
          data: { taxEnabled: false, taxIncludedInPrice: false },
        });
        sqlite.exec(
          `DELETE FROM store_config WHERE store_id = '${STORE}'; DELETE FROM store_tax_profiles; DELETE FROM tax_rates;`
        );
      };
    };
    for (const included of [false, true]) {
      const undo = await withTax(included);
      try {
        const t = await parity(10, async w => {
          const o = (await place(w, 2, { couponCode: w.coupon }, 1)) as { id: string };
          const partial = {
            items: [],
            refundKey: `refund:t-${included}`,
            refundAmount: 4_000,
            amountOnly: true,
          };
          if (
            (await (await import('../../apps/api/src/lib/repo-factory')).storeMoney(STORE)) === null
          )
            await handleOrderRefunded(o.id, STORE, false, false, inlineStep, partial);
          else
            await OrderService.applyRefundEffects(STORE, o.id, {
              restoreInventory: false,
              fireRefundNotification: false,
              partial,
            });
          return 'done';
        });
        const invoice = t.state.fiscal.find((d: any) => d.docType === 'tax_invoice');
        expect(invoice).toMatchObject({ sellerTrn: '100200300', vatRateBps: 1400 });
        expect(invoice.vatAmount).toBeGreaterThan(0);
        expect(invoice.payload.buyer.name).toBe('Mona Adel');
        expect(t.state.fiscal.some((d: any) => d.docType === 'credit_note')).toBe(true);
      } finally {
        await undo();
      }
    }
  });

  it('order reads: getById, getByOrderNumber, list (filters, cursor), customer orders and the created order carry the same shape, customer attached', async () => {
    const t = await parity(10, async w => {
      const user = await prisma.user.create({
        data: {
          email: `reader-${Math.random().toString(36).slice(2)}@example.test`,
          passwordHash: 'x'.repeat(60),
          firstName: 'Reader',
          lastName: 'One',
          phone: '+201099999999',
          role: 'customer',
          storeId: STORE,
          status: 'active',
        },
      });
      sqlite
        .prepare(
          `INSERT OR IGNORE INTO customers (id, store_id, email, first_name, last_name, user_id) VALUES (?, ?, ?, 'Reader', 'One', ?)`
        )
        .run(`crm-${user.id}`, STORE, user.email, user.id); // the CRM id DIFFERS from the platform user id (Ruling CF-FIX-2)
      const mine = async (extra: Record<string, unknown>, i: number) => {
        const sessionId = cartSessionId('d2b2r');
        await (
          await storeWriter(STORE)
        ).cartItem.create({
          data: {
            cartId: (await CartService.getOrCreate(STORE, sessionId, user.id)).id,
            productId: w.product,
            quantity: 1,
          },
        });
        return OrderService.create(
          STORE,
          user.id,
          sessionId,
          { shippingAddress: address(i), paymentMethod: 'cod', ...extra } as never,
          undefined,
          undefined
        );
      };
      const a = (await mine({}, 1)) as { id: string; orderNumber: string };
      const b = (await mine({ notes: 'second' }, 2)) as { id: string };
      await place(w, 1, {}, 3); // a guest order: not in the customer's list
      await OrderService.updateStatus(STORE, b.id, 'cancelled');
      if ((await (await import('../../apps/api/src/lib/repo-factory')).storeMoney(STORE)) === null)
        await handleOrderRefunded(b.id, STORE, true, false, inlineStep);
      const brief = (o: any) => ({
        status: o.status,
        total: o.total,
        items: o.items?.map((i: any) => ({ qty: i.quantity, total: i.total })),
        payments: o.payments,
        count: o._count,
        customer: o.customer && {
          email: o.customer.email === user.email ? '<email>' : o.customer.email,
          firstName: o.customer.firstName,
          lastName: o.customer.lastName,
          phone: o.customer.phone,
        },
      });
      const byId = await OrderService.getById(STORE, a.id);
      const byNumber = await OrderService.getByOrderNumber(STORE, a.orderNumber);
      const list = await OrderService.list(STORE, { customerId: user.id, limit: 1 });
      const next = await OrderService.list(STORE, {
        customerId: user.id,
        limit: 1,
        cursor: list.orders[0].id,
      });
      const cancelledOnly = await OrderService.list(STORE, {
        customerId: user.id,
        status: 'cancelled',
      });
      const mineOrders = await OrderService.getCustomerOrders(STORE, user.id);
      const gone = await settle(() => OrderService.getById(STORE, 'does-not-exist'));
      return {
        byId: brief(byId),
        byNumber: brief(byNumber),
        list: {
          orders: list.orders.map(brief),
          total: list.meta.total,
          next: !!list.meta.nextCursor,
        },
        page2: { orders: next.orders.map(brief), total: next.meta.total },
        cancelledOnly: cancelledOnly.orders.map(brief),
        mine: { n: mineOrders.orders.length, total: mineOrders.meta.total },
        gone,
      };
    });
    expect(t.out.ok.byId.customer).toMatchObject({ firstName: 'Reader' });
    expect(t.out.ok.list.total).toBe(2);
    expect(t.out.ok.cancelledOnly).toHaveLength(1);
    expect(t.out.ok.gone.err.status).toBe(404);
  });

  it('admin order search (Ruling CF-R4-1): order number, registered customers, guest contacts, Arabic folding, any phone form, e-mail, literal wildcards', async () => {
    const t = await parity(40, async w => {
      const regs = [
        { first: 'أحمد', last: 'سعيد', phone: '+201012345678', mail: 'ahmed.reg@example.test' },
        { first: 'Laila', last: 'Hassan', phone: '+201199887766', mail: 'laila.reg@example.test' },
      ];
      const users: string[] = [];
      let i = 0;
      for (const r of regs) {
        const user = await prisma.user.create({
          data: {
            email: `${Date.now()}${i}${Math.floor(Math.random() * 1e9)}-${r.mail}`, // digits only: no Latin letters to collide with a search term
            passwordHash: 'x'.repeat(60),
            firstName: r.first,
            lastName: r.last,
            phone: r.phone,
            role: 'customer',
            storeId: STORE,
            status: 'active',
          },
        });
        users.push(user.id);
        if (await storeMoney(STORE))
          sqlite
            .prepare(
              `INSERT OR IGNORE INTO customers (id, store_id, email, first_name, last_name, phone, user_id) VALUES (?, ?, ?, ?, ?, ?, ?)`
            )
            .run(`crm-${user.id}`, STORE, user.email, r.first, r.last, r.phone, user.id);
        const sessionId = cartSessionId('r4s');
        await (
          await storeWriter(STORE)
        ).cartItem.create({
          data: {
            cartId: (await CartService.getOrCreate(STORE, sessionId, user.id)).id,
            productId: w.product,
            quantity: 1,
          },
        });
        await OrderService.create(
          STORE,
          user.id,
          sessionId,
          { shippingAddress: address(++i), paymentMethod: 'cod' } as never,
          undefined,
          undefined
        );
      }
      const guests = [
        {
          firstName: 'فاطمة',
          lastName: 'الزهراء',
          phone: '01234567890',
          email: 'fatma.guest@example.test',
        },
        {
          firstName: 'Mostafa',
          lastName: 'Kamel',
          phone: '+20 109 555 0102',
          email: 'mk@shop.example',
        },
        {
          firstName: 'Ahmed',
          lastName: 'Saeed',
          phone: '٠١٠٠٢٢٢٣٣٣٣',
          email: 'ahmed.saeed@example.test',
        },
      ];
      const placed: Array<{ id: string; orderNumber: string }> = [];
      for (const g of guests)
        placed.push(
          (await place(w, 1, { shippingAddress: { ...address(++i), ...g } }, i)) as never
        );
      const brief = (o: any) =>
        o.customer
          ? `${o.customer.firstName} ${o.customer.lastName}`
          : `${o.shippingAddress?.firstName} ${o.shippingAddress?.lastName}`;
      const search = async (q: string, extra: Record<string, unknown> = {}) => {
        // the Postgres search definers take the store only from `app.current_store_id` (what tenantContext gives a real request)
        const r = await settle(() =>
          runInTenantContext(STORE, () =>
            OrderService.list(STORE, { search: q, ...extra } as never)
          )
        );
        if ('err' in r) return r;
        return { names: r.ok.orders.map(brief).sort(), total: r.ok.meta.total };
      };
      const num = placed[0].orderNumber;
      const terms = [
        num, // the whole number
        num.slice(num.indexOf('-') + 1), // the random part of it (never a bare phone-like digit run)
        'ORD-', // matches every order
        'احمد', // folded: finds أحمد (registered) and Ahmed is Latin so not
        'أحمد',
        'ahmed', // latin: the guest, not the Arabic registered customer
        'سعيد',
        'فاطمه', // ة / ه fold
        'Laila Hassan', // both tokens (AND)
        'hassan laila', // any order
        '01012345678', // phone, national form
        '+20 101 234 5678',
        '٠١٠١٢٣٤٥٦٧٨', // Arabic-Indic digits
        '0109 555 0102', // guest, spaced
        '01002223333', // guest typed in Arabic-Indic digits
        'laila.reg', // e-mail part
        'mk@shop', // guest e-mail
        'EXAMPLE.TEST', // case-insensitive
        '%', // literal
        '_',
        'zzzzzz', // no match
        // Shorter than a trigram. NOT a Latin pair such as 'ab': the Postgres world and the DO world each mint their own RANDOM
        // order numbers and e-mails, and a pair that one random number happens to contain (and the other not) read as a parity
        // break (the flake this replaces: ~1 run in 3). Arabic never occurs in a random id, and still finds 'سعيد'.
        'سع',
      ];
      const out: Record<string, unknown> = {};
      for (const q of terms)
        out[q === num ? '<num>' : q === num.slice(num.indexOf('-') + 1) ? '<part>' : q] =
          await search(q);
      out['own orders'] = await search('hassan', { customerId: users[1] });
      out['other customer'] = await search('hassan', { customerId: users[0] });
      out['status filter'] = await search('example.test', { status: 'cancelled' });
      return out;
    });
    const o = t.out.ok;
    expect(o['<num>'].total).toBe(1);
    expect(o['احمد'].names).toEqual(expect.arrayContaining(['أحمد سعيد']));
    expect(o['Laila Hassan'].total).toBe(1);
    expect(o['zzzzzz'].total).toBe(0);
  });

  it('admin order search: a term that matches nothing is empty, a scanned order barcode opens exactly that order', async () => {
    const t = await parity(5, async w => {
      const o = (await place(w, 1, {}, 1)) as { orderNumber: string };
      const list = (q: string) =>
        runInTenantContext(STORE, () => OrderService.list(STORE, { search: q } as never));
      const none = await list('no-such-person-xyz');
      return {
        none: none.orders.length,
        byNumber: (await OrderService.list(STORE, { search: o.orderNumber } as never)).orders
          .length,
      };
    });
    expect(t.out.ok).toEqual({ none: 0, byNumber: 1 });
  });

  // PR R4 (Ruling CF-R4-2): the merchant's manual order. Same scenario on Postgres (the unchanged code) and on the DO engine.
  const adminAddr = (i: number, extra: Record<string, unknown> = {}) => ({
    ...address(i),
    email: 'phone.buyer@example.test',
    area: 'Cairo',
    ...extra,
  });
  const adminTrace = async (ids: string[]) => {
    const { storeDb } = await import('../../apps/api/src/lib/repo-factory');
    const db = (await storeDb(STORE)) as any;
    const events = await db.orderEvent.findMany({
      where: { orderId: { in: ids } },
      select: { toStatus: true, metadata: true },
    });
    return events
      .map((e: any) => ({ to: e.toStatus, meta: canon(e.metadata) }))
      .sort((a: any, b: any) => {
        // the coupon code is random per world, so it cannot be part of the order
        const k = (e: any) => JSON.stringify({ ...e, meta: { ...e.meta, couponCode: undefined } });
        return k(a).localeCompare(k(b));
      });
  };
  const mkCoupon = async (w: World, data: Record<string, unknown>) => {
    const code = `A${Math.random().toString(36).slice(2, 8)}`.toUpperCase();
    const row = await prisma.coupon.create({
      data: {
        storeId: STORE,
        code,
        name: 'c',
        type: 'fixed',
        value: 1_500,
        isActive: true,
        ...data,
      } as never,
    });
    insertSqlite(sqlite, 'Coupon', [row] as never);
    w.names[row.id] = 'coupon2';
    w.names[code] = 'code2';
    return code;
  };
  const admin = (
    w: World,
    items: Array<{ productId: string; variantId?: string; quantity: number }>,
    extra: Record<string, unknown> = {},
    role = 'store_admin',
    i = 1
  ) =>
    OrderService.createAdminOrder(
      STORE,
      ownerId,
      { shippingAddress: adminAddr(i), items, ...extra } as never,
      { role }
    ) as Promise<{ id: string; total: number }>;

  it('admin (manual) order: guest, totals, items, stock RESERVED (STOCK-SYMMETRY-1 superseded 2026-11-11), the sale document and the cart rows are the same', async () => {
    const t = await parity(10, async w => {
      const o = await admin(w, [{ productId: w.product, quantity: 3 }], { notes: 'phone order' });
      return { total: o.total, events: await adminTrace([o.id]) };
    });
    // the order takes its 3 units like checkout and records one ledger row, on BOTH backends
    expect(t.state.products[0].inventory).toBe(7);
    expect(t.state.history).toEqual([
      { type: 'sale', quantity: -3, previousStock: 10, newStock: 7 },
    ]);
    // no stock_not_taken marker: it took everything, so a cancel / refund puts everything back
    expect(t.out.ok.events).toEqual([]);
    expect(t.state.orders[0]).toMatchObject({
      subtotal: 30_000,
      status: 'pending',
      notes: 'phone order',
    });
    expect(t.state.fiscal).toHaveLength(1);
  });

  it('admin (manual) order cancelled: the units it took go back on the shelf, symmetric (STOCK-SYMMETRY-1 superseded 2026-11-11)', async () => {
    const t = await parity(10, async w => {
      const o = await admin(w, [{ productId: w.product, quantity: 3 }]);
      await OrderService.updateStatus(STORE, o.id, 'cancelled');
      if ((await (await import('../../apps/api/src/lib/repo-factory')).storeMoney(STORE)) === null)
        await handleOrderRefunded(o.id, STORE, true, false, inlineStep);
      return 'done';
    });
    expect(t.state.orders[0].status).toBe('cancelled');
    // 10 - 3 taken at placement + 3 restored on cancel (was 13 before #633, when it restocked units it never took)
    expect(t.state.products[0].inventory).toBe(10);
    expect(t.state.history.map((h: { type: string }) => h.type).sort()).toEqual([
      'return_stock',
      'sale',
    ]);
  });

  it('admin order: short stock is refused 422 INSUFFICIENT_STOCK and nothing is kept; only a store admin with a reason overrides, it takes what is on hand, and a cancel restocks only that', async () => {
    const t = await parity(2, async w => {
      const item = [{ productId: w.product, quantity: 3 }];
      const out: Record<string, unknown> = {};
      out.refused = await settle(() => admin(w, item));
      out.afterRefusal = (await state(w)).products;
      out.staff = await settle(() =>
        admin(w, item, { overrideStock: true, stockOverrideReason: 'phone deal' }, 'staff')
      );
      out.noReason = await settle(() => admin(w, item, { overrideStock: true }));
      const r = await settle(() =>
        admin(w, item, { overrideStock: true, stockOverrideReason: 'phone deal' })
      );
      out.override = 'ok' in r ? { total: r.ok.total } : r;
      out.events = await adminTrace('ok' in r ? [r.ok.id] : []);
      out.afterOverride = (await state(w)).products;
      if ('ok' in r) {
        await OrderService.updateStatus(STORE, r.ok.id, 'cancelled');
        if ((await storeMoney(STORE)) === null)
          await handleOrderRefunded(r.ok.id, STORE, true, false, inlineStep);
      }
      return out;
    });
    const o = t.out.ok;
    expect(o.refused.err).toMatchObject({ status: 422, code: 'INSUFFICIENT_STOCK' });
    expect(o.afterRefusal).toEqual([{ inventory: 2 }]); // the refused order left no trace
    expect(o.staff.err.status).toBe(403);
    expect(o.noReason.err.status).toBe(400);
    expect(o.override.total).toBeGreaterThan(0);
    expect(o.afterOverride).toEqual([{ inventory: 0 }]); // took the 2 on hand
    expect(o.events.map((e: { to: string }) => e.to).sort()).toEqual([
      'stock_not_taken',
      'stock_override',
    ]);
    expect(o.events.find((e: { to: string }) => e.to === 'stock_not_taken').meta.items).toEqual([
      { orderItemId: '<id>', quantity: 1 },
    ]);
    expect(t.state.products[0].inventory).toBe(2); // the cancel put back 2, not 3
    expect(t.state.orders).toHaveLength(1); // the refused and rejected attempts created nothing
  });

  it('admin order: staff cannot override a stock shortage, and an override without a (non-blank) reason is refused, on both backends', async () => {
    const t = await parity(2, async w => {
      const item = [{ productId: w.product, quantity: 5 }];
      const out: Record<string, unknown> = {};
      out.staffWithReason = await settle(() =>
        admin(w, item, { overrideStock: true, stockOverrideReason: 'phone deal' }, 'staff')
      );
      out.staffNoReason = await settle(() => admin(w, item, { overrideStock: true }, 'staff'));
      out.noRole = await settle(() =>
        OrderService.createAdminOrder(
          STORE,
          ownerId,
          {
            shippingAddress: adminAddr(1),
            items: item,
            overrideStock: true,
            stockOverrideReason: 'phone deal',
          } as never,
          {}
        )
      );
      out.adminNoReason = await settle(() => admin(w, item, { overrideStock: true }));
      out.adminBlankReason = await settle(() =>
        admin(w, item, { overrideStock: true, stockOverrideReason: '   ' })
      );
      return out;
    });
    const o = t.out.ok;
    expect(o.staffWithReason.err).toMatchObject({ status: 403, code: 'STOCK_OVERRIDE_FORBIDDEN' });
    expect(o.staffNoReason.err).toMatchObject({ status: 403, code: 'STOCK_OVERRIDE_FORBIDDEN' });
    expect(o.noRole.err).toMatchObject({ status: 403, code: 'STOCK_OVERRIDE_FORBIDDEN' });
    expect(o.adminNoReason.err).toMatchObject({
      status: 400,
      code: 'STOCK_OVERRIDE_REASON_REQUIRED',
    });
    expect(o.adminBlankReason.err).toMatchObject({
      status: 400,
      code: 'STOCK_OVERRIDE_REASON_REQUIRED',
    });
    // every refusal happened before any write: no order, stock untouched, no ledger row
    expect(t.state.orders).toEqual([]);
    expect(t.state.products[0].inventory).toBe(2);
    expect(t.state.history).toEqual([]);
  });

  it('admin order: a legacy order that carries the stock_not_taken marker (took nothing) still restocks nothing on cancel', async () => {
    const t = await parity(10, async w => {
      const o = await admin(w, [{ productId: w.product, quantity: 3 }]);
      // turn it into a pre-change order: it took no stock and carries the full-line marker
      const isDo = (await storeMoney(STORE)) !== null;
      await prisma.product.update({ where: { id: w.product }, data: { inventory: 10 } });
      sqlite.prepare('UPDATE products SET inventory = 10 WHERE id = ?').run(w.product);
      const itemId = isDo
        ? (
            sqlite.prepare('SELECT id FROM order_items WHERE order_id = ?').get(o.id) as {
              id: string;
            }
          ).id
        : (await prisma.orderItem.findFirstOrThrow({ where: { orderId: o.id } })).id;
      if (isDo)
        sqlite
          .prepare(
            `INSERT INTO order_events (id, store_id, order_id, from_status, to_status, actor_id, metadata, created_at) VALUES (?, ?, ?, NULL, 'stock_not_taken', ?, ?, ?)`
          )
          .run(
            crypto.randomUUID(),
            STORE,
            o.id,
            ownerId,
            JSON.stringify({ items: [{ orderItemId: itemId, quantity: 3 }] }),
            Date.now()
          );
      else
        await prisma.orderEvent.create({
          data: {
            storeId: STORE,
            orderId: o.id,
            fromStatus: null,
            toStatus: 'stock_not_taken',
            actorId: ownerId,
            metadata: { items: [{ orderItemId: itemId, quantity: 3 }] },
          },
        });
      await OrderService.updateStatus(STORE, o.id, 'cancelled');
      if (!isDo) await handleOrderRefunded(o.id, STORE, true, false, inlineStep);
      return 'done';
    });
    expect(t.state.orders[0].status).toBe('cancelled');
    expect(t.state.products[0].inventory).toBe(10); // legacy behaviour kept: nothing phantom put back
  });

  it('admin order: a coupon is claimed once, discounts like checkout, a negotiated shipping fee replaces the computed one', async () => {
    const t = await parity(10, async w => {
      const o = await admin(w, [{ productId: w.product, quantity: 2 }], {
        couponCode: w.coupon.toLowerCase(),
        shippingOverride: 2_500,
      });
      return { total: o.total };
    });
    expect(t.state.coupons[0].usageCount).toBe(1);
    expect(t.state.orders[0]).toMatchObject({
      couponDiscount: 0,
      discount: 1_000,
      shipping: 2_500,
    });
  });

  it('admin order: coupon rules are enforced (same code), an override needs a store admin and a reason and is recorded as an event', async () => {
    const t = await parity(10, async w => {
      const expired = await mkCoupon(w, { expiresAt: new Date(Date.now() - 86_400_000) });
      const minimum = await mkCoupon(w, { minOrderAmount: 999_999 });
      const used = await mkCoupon(w, { usageLimit: 1, usageCount: 1 });
      const item = [{ productId: w.product, quantity: 1 }];
      const out: Record<string, unknown> = {};
      for (const [name, code] of [
        ['expired', expired],
        ['minimum', minimum],
        ['used', used],
      ] as const) {
        out[`${name} enforced`] = await settle(() => admin(w, item, { couponCode: code }));
        out[`${name} staff`] = await settle(() =>
          admin(
            w,
            item,
            { couponCode: code, overrideCouponRules: true, couponOverrideReason: 'phone deal' },
            'staff'
          )
        );
      }
      out['no reason'] = await settle(() =>
        admin(w, item, { couponCode: expired, overrideCouponRules: true })
      );
      const ids: string[] = [];
      for (const [name, code] of [
        ['expired', expired],
        ['minimum', minimum],
        ['used', used],
      ] as const) {
        const r = await settle(() =>
          admin(w, item, {
            couponCode: code,
            overrideCouponRules: true,
            couponOverrideReason: 'phone deal',
          })
        );
        out[`${name} override`] = 'ok' in r ? { total: r.ok.total } : r;
        if ('ok' in r) ids.push(r.ok.id);
      }
      out.events = await adminTrace(ids);
      out.unknown = await settle(() => admin(w, item, { couponCode: 'NOPE-NOPE' }));
      return out;
    });
    const o = t.out.ok;
    expect(o['expired enforced'].err.code).toBe('COUPON_EXPIRED');
    expect(o['minimum enforced'].err.code).toBe('MIN_ORDER_NOT_MET');
    expect(o['used enforced'].err.code).toBe('COUPON_LIMIT_REACHED');
    expect(o['expired staff'].err.status).toBe(403);
    expect(o['no reason'].err.status).toBe(400);
    // one override event per overridden order; a fully stocked order writes no stock_not_taken marker any more
    expect(o.events.filter((e: { to: string }) => e.to === 'coupon_override')).toHaveLength(3);
    expect(o.events).toHaveLength(3);
    expect(o.unknown.err.status).toBe(404);
  });

  it('admin order: minimum order quantity is refused 422, overridable by a store admin with a reason (event), staff refused', async () => {
    const t = await parity(20, async w => {
      await prisma.product.update({ where: { id: w.product }, data: { moq: 5 } });
      sqlite.prepare('UPDATE products SET moq = 5 WHERE id = ?').run(w.product);
      const item = [{ productId: w.product, quantity: 2 }];
      const out: Record<string, unknown> = {};
      out.refused = await settle(() => admin(w, item));
      out.staff = await settle(() =>
        admin(w, item, { overrideMoq: true, moqOverrideReason: 'phone deal' }, 'staff')
      );
      out.noReason = await settle(() => admin(w, item, { overrideMoq: true }));
      const r = await settle(() =>
        admin(w, item, { overrideMoq: true, moqOverrideReason: 'phone deal' })
      );
      out.override = 'ok' in r ? { total: r.ok.total } : r;
      out.events = await adminTrace('ok' in r ? [r.ok.id] : []);
      out.enough = await settle(() => admin(w, [{ productId: w.product, quantity: 5 }]));
      return out;
    });
    const o = t.out.ok;
    expect(o.refused.err).toMatchObject({ status: 422, code: 'BELOW_MOQ' });
    expect(o.staff.err.status).toBe(403);
    expect(o.override.total).toBeGreaterThan(0);
    // the override event only: the order took all its stock, so there is no stock_not_taken marker
    expect(o.events.map((e: { to: string }) => e.to)).toEqual(['moq_override']);
  });

  it('admin order: refusals (unknown product, variant required / unknown / disabled) carry the same status and code, and a variant line is priced from the variant', async () => {
    const t = await parity(20, async w => {
      const mkVariant = async (data: Record<string, unknown>) => {
        const v = await prisma.productVariant.create({
          data: {
            productId: w.product,
            title: 'L',
            sku: `V${Math.random().toString(36).slice(2, 7)}`,
            price: 12_000,
            inventory: 5,
            isActive: true,
            ...data,
          } as never,
        });
        if (await storeMoney(STORE)) insertSqlite(sqlite, 'ProductVariant', [v] as never); // the product is mirrored on the DO run only
        w.names[v.id] = 'variant';
        w.names[v.sku as string] = 'sku';
        return v.id;
      };
      const ghost = await settle(() => admin(w, [{ productId: crypto.randomUUID(), quantity: 1 }]));
      const ok = await mkVariant({});
      const off = await mkVariant({ title: 'XL', isActive: false });
      const out: Record<string, unknown> = {};
      out.ghost = ghost;
      out.required = await settle(() => admin(w, [{ productId: w.product, quantity: 1 }]));
      out.unknown = await settle(() =>
        admin(w, [{ productId: w.product, variantId: crypto.randomUUID(), quantity: 1 }])
      );
      out.disabled = await settle(() =>
        admin(w, [{ productId: w.product, variantId: off, quantity: 1 }])
      );
      const r = await settle(() =>
        admin(w, [{ productId: w.product, variantId: ok, quantity: 2 }])
      );
      out.variant = 'ok' in r ? { total: r.ok.total } : r;
      return out;
    });
    const o = t.out.ok;
    expect(o.ghost.err).toMatchObject({ status: 404, code: 'PRODUCT_NOT_FOUND' });
    expect(o.required.err).toMatchObject({ status: 400, code: 'VARIANT_REQUIRED' });
    expect(o.unknown.err.code).toBe('VARIANT_NOT_FOUND');
    expect(o.disabled.err).toMatchObject({ status: 409, code: 'VARIANT_INACTIVE' });
    expect(o.variant.total).toBeGreaterThan(24_000 - 1);
  });

  it('a plain order: totals, items, stock and the sale ledger row are the same', async () => {
    const t = await parity(10, w => place(w, 3));
    expect(t.state.products[0].inventory).toBe(7);
    expect(t.state.history).toEqual([
      { type: 'sale', quantity: -3, previousStock: 10, newStock: 7 },
    ]);
    expect(t.state.orders[0]).toMatchObject({ subtotal: 30_000, status: 'pending' });
  });

  it('an order with a coupon claims one use; the discount is the same', async () => {
    const t = await parity(10, w => place(w, 2, { couponCode: w.coupon }));
    expect(t.state.coupons[0].usageCount).toBe(1);
    expect(t.state.orders[0].couponDiscount).toBe(1_000);
  });

  it('the last items: the second order is refused with the same status and takes nothing', async () => {
    const t = await parity(3, async w => ({
      first: await place(w, 3, {}, 1),
      second: await place(w, 1, {}, 2).catch(e => ({ refused: e.statusCode, code: e.code })),
    }));
    expect(t.state.products[0].inventory).toBe(0);
    expect(t.state.orders).toHaveLength(1);
  });

  it('a coupon at its usage limit (2): the third order is refused and the count stays 2', async () => {
    const t = await parity(20, async w => {
      const r: unknown[] = [];
      for (let i = 1; i <= 3; i++)
        r.push(
          await place(w, 1, { couponCode: w.coupon }, i).catch(e => ({
            refused: e.statusCode,
            code: e.code,
          }))
        );
      return r;
    });
    expect(t.state.coupons[0].usageCount).toBe(2);
    expect(t.state.orders).toHaveLength(2);
  });

  it('cancel: status, stock and the coupon use come back, and a second cancel changes nothing', async () => {
    const t = await parity(10, async w => {
      const o = (await place(w, 4, { couponCode: w.coupon })) as { id: string };
      await OrderService.updateStatus(STORE, o.id, 'cancelled');
      // Postgres reverses in the order/refunded fanout (the DO already did, in the cancel section): run it inline
      if ((await (await import('../../apps/api/src/lib/repo-factory')).storeMoney(STORE)) === null)
        await handleOrderRefunded(o.id, STORE, true, false, inlineStep);
      await OrderService.updateStatus(STORE, o.id, 'cancelled').catch(() => undefined);
      return 'done';
    });
    expect(t.state.products[0].inventory).toBe(10);
    expect(t.state.coupons[0].usageCount).toBe(0);
    expect(t.state.orders[0].status).toBe('cancelled');
  });

  // PR D2b-4 (Ruling CF-FINAL-1): the plain status transitions
  const statusTrace = async (orderId: string) => {
    const { storeDb } = await import('../../apps/api/src/lib/repo-factory');
    const db = (await storeDb(STORE)) as any;
    const o = await db.order.findFirst({
      where: { id: orderId },
      select: {
        status: true,
        paymentStatus: true,
        deliveredAt: true,
        statusFanoutRequestedStatus: true,
        statusFanoutRequestedAt: true,
        statusFanoutClaimedAt: true,
        payments: { select: { status: true, provider: true } },
      },
    });
    const events = await db.orderEvent.findMany({
      where: { orderId },
      select: { fromStatus: true, toStatus: true },
    });
    return {
      status: o.status,
      paymentStatus: o.paymentStatus,
      delivered: o.deliveredAt !== null,
      fanoutStatus: o.statusFanoutRequestedStatus,
      armed: o.statusFanoutRequestedAt !== null && o.statusFanoutClaimedAt === null,
      payments: o.payments,
      events: events.map((e: any) => `${e.fromStatus}>${e.toStatus}`).sort(),
    };
  };
  const codPayment = async (orderId: string, total: number) => {
    const { storeMoney } = await import('../../apps/api/src/lib/repo-factory');
    const money = await storeMoney(STORE);
    if (money) await money.paymentCreate({ orderId, provider: 'cod', amount: total });
    else
      await prisma.payment.create({
        data: { orderId, provider: 'cod', status: 'cod_pending', amount: total, currency: 'EGP' },
      });
  };

  it('status chain: confirmed, processing, shipped, delivered; COD is settled on delivery (MONEYB-7)', async () => {
    const t = await parity(10, async w => {
      const o = (await place(w, 2)) as { id: string; total: number };
      await codPayment(o.id, o.total);
      const trace: unknown[] = [];
      for (const st of ['confirmed', 'processing', 'shipped', 'delivered'] as const) {
        await OrderService.updateStatus(STORE, o.id, st);
        trace.push(await statusTrace(o.id));
      }
      return trace;
    });
    const last = t.out.ok[3];
    expect(last).toMatchObject({ status: 'delivered', paymentStatus: 'paid', delivered: true });
    expect(last.payments).toEqual([{ status: 'completed', provider: 'cod' }]);
  });

  it('status refusals: a backwards move and an unconfirmed InstaPay hold have the same code on both backends', async () => {
    const t = await parity(10, async w => {
      const o = (await place(w, 1)) as { id: string };
      await OrderService.updateStatus(STORE, o.id, 'shipped');
      const back = await settle(() => OrderService.updateStatus(STORE, o.id, 'confirmed'));
      return { back, after: await statusTrace(o.id) };
    });
    expect(t.out.ok.back.err.code).toBe('INVALID_STATUS_TRANSITION');
    expect(t.out.ok.after.status).toBe('shipped');
  });

  it('quote (dryRun): the same totals and line prices on both backends, nothing reserved, no refusal for stock', async () => {
    const t = await parity(1, async w => {
      const sessionId = cartSessionId('d2b4q');
      const cart = await CartService.getOrCreate(STORE, sessionId, undefined);
      await (
        await storeWriter(STORE)
      ).cartItem.create({
        data: { cartId: cart.id, productId: w.product, quantity: 3 },
      });
      const q = await OrderService.quote(
        STORE,
        undefined,
        sessionId,
        { shippingAddress: address(1), paymentMethod: 'cod', couponCode: w.coupon } as never,
        { kind: 'anonymous' } as never
      );
      // the cart is untouched and (3 > 1 in stock) the order itself is refused
      const again = await settle(() =>
        OrderService.create(
          STORE,
          undefined,
          sessionId,
          { shippingAddress: address(1), paymentMethod: 'cod' } as never,
          undefined,
          undefined
        )
      );
      return { q, again };
    });
    expect(t.out.ok.q).toMatchObject({ subtotal: 30_000, discount: 1_000 });
    expect(t.out.ok.q.lines).toHaveLength(1);
    expect(t.out.ok.again.err.code).toBe('INSUFFICIENT_INVENTORY');
    expect(t.state.products[0].inventory).toBe(1);
    expect(t.state.coupons[0].usageCount).toBe(0);
    expect(t.state.orders).toHaveLength(0);
  });

  it('two concurrent submits of one cart create exactly one order on both backends (CF-ORDERS-CART-1 closed)', async () => {
    const counts: Record<string, number> = {};
    for (const [name, on, mirror] of [
      ['pg', onPg, false],
      ['do', onDo, true],
    ] as const) {
      phoneSeq++;
      const w = await world(10, mirror);
      const out = await on(async () => {
        const sessionId = cartSessionId('d2b4c');
        const cart = await CartService.getOrCreate(STORE, sessionId, undefined);
        await (
          await storeWriter(STORE)
        ).cartItem.create({
          data: { cartId: cart.id, productId: w.product, quantity: 2 },
        });
        const submit = (i: number) =>
          settle(() =>
            OrderService.create(
              STORE,
              undefined,
              sessionId,
              { shippingAddress: address(i), paymentMethod: 'cod' } as never,
              undefined,
              undefined
            )
          );
        return Promise.all([submit(1), submit(1), submit(1)]);
      });
      const made = out.filter((o: any) => o.ok);
      counts[name] = made.length;
      for (const o of out.filter((x: any) => x.err))
        expect(['CART_CHANGED', 'EMPTY_CART']).toContain((o as any).err.code);
      expect((await on(() => state(w))).products[0].inventory).toBe(8);
    }
    expect(counts).toEqual({ pg: 1, do: 1 });
  });

  // PR D2b-4 (Ruling CF-FINAL-1): personalisation text and the delivery date, written like Postgres writes them
  it('personalisation text lands on the order item, and a delivery date becomes the first line of the notes', async () => {
    const { deliveryDateChoices } = await import('@ebda/shared');
    const store = await prisma.store.findUniqueOrThrow({ where: { id: STORE } });
    const prior = store.settings;
    await prisma.store.update({
      where: { id: STORE },
      data: { settings: { checkoutDelivery: { daysAhead: 4 }, deliveryOffDays: [] } as never },
    });
    try {
      const choices = deliveryDateChoices({
        now: new Date(),
        timeZone: store.timezone ?? undefined,
        offDays: [],
        windows: [],
        daysAhead: 4,
        estimateDays: 0,
        maxLeadTimeDays: 0,
      });
      const date = (choices[0] as { date: string }).date;
      const t = await parity(10, async w => {
        const place1 = async (extra: Record<string, unknown>, note?: string) => {
          const sessionId = cartSessionId('d2b4p');
          const cart = await CartService.getOrCreate(STORE, sessionId, undefined);
          await (
            await storeWriter(STORE)
          ).cartItem.create({
            data: { cartId: cart.id, productId: w.product, quantity: 1, note: note ?? null },
          });
          return settle(() =>
            OrderService.create(
              STORE,
              undefined,
              sessionId,
              { shippingAddress: address(1), paymentMethod: 'cod', ...extra } as never,
              undefined,
              undefined
            )
          );
        };
        const missing = await place1({});
        const good = await place1(
          { deliveryDate: date, notes: 'ring twice' },
          'Happy birthday Mona'
        );
        const { storeDb } = await import('../../apps/api/src/lib/repo-factory');
        const db = (await storeDb(STORE)) as any;
        const o = await db.order.findFirst({
          where: { items: { some: { productId: w.product } } },
          select: { notes: true, items: { select: { personalisation: true } } },
        });
        return { missing, goodOk: 'ok' in good, o };
      });
      expect(t.out.ok.missing.err.code).toBe('DELIVERY_SLOT_UNAVAILABLE');
      expect(t.out.ok.goodOk).toBe(true);
      expect(t.out.ok.o.items[0].personalisation).toBe('Happy birthday Mona');
      expect(t.out.ok.o.notes).toMatch(/ring twice/);
    } finally {
      await prisma.store.update({ where: { id: STORE }, data: { settings: prior as never } });
    }
  });
});
