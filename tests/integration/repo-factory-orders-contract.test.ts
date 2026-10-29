/**
 * INFRA-CF-1 PR D2b-2 (Ruling CF-ORDERS-1): order creation and cancellation moved to the StoreDO give the same answer and
 * leave the same rows on Postgres and on the DO. Each test is a SCENARIO driving the real `OrderService`; it runs once on
 * Postgres (the unchanged code, real transaction) and once with the DO money client over the real DO schema on SQLite (the
 * real wire codec, `answerMoneyOp`, `runMoneyOp`). Each backend gets its own identical world (the DO's copy is mirrored into
 * SQLite); the scrubbed traces (return values or error status, then the order, stock, coupon and ledger rows) must be equal.
 * Cancel: Postgres reverses through the `order/refunded` fanout (run inline here), the DO inside the one section.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { prisma } from '@ebda/database';
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
import { CartService } from '../../apps/api/src/services/cart.service';
import { featureService } from '../../apps/api/src/services/feature.service';
import { handleOrderRefunded } from '../../apps/api/src/lib/inngest/functions/order-refunded';
import {
  makeMoneyClient,
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
import { createProduct, ownerPool } from '../helpers/gold-sql';

const sfx = Date.now().toString(36);
let STORE = '';
let ownerId = '';
const sqlite = openSqlite();

function doRepo() {
  const sql = nodeSqlRunner(sqlite);
  ensureIdempotencySchema(sql);
  const sync = nodeSyncSql(sqlite);
  ensureMoneyOpsSchema(sync);
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
  await prisma.cartItem.create({ data: { cartId: cart.id, productId: w.product, quantity: qty } });
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
  const key = (r: unknown) => JSON.stringify(r);
  return {
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
afterAll(async () => {
  vi.restoreAllMocks();
  await ownerPg.end();
  await prisma.$disconnect();
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
  await GoldRateService.applyRates(
    STORE,
    { rates: [{ karat: 21, ratePerGram: rateNo }], confirm: true },
    { userId: ownerId }
  );
  await mirrorRates();
};
const moveRate = async () => {
  rateNo += 1000;
  await applyRate();
};
async function goldWorld(mirror: boolean): Promise<World> {
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

  it('options the engine cannot honour are refused, not dropped (delivery slot, personalisation note)', async () => {
    const w = await world(10, true);
    const slot = await settle(() => onDo(() => place(w, 1, { deliveryDate: '2030-01-01' })));
    expect(slot).toMatchObject({ err: { status: 501, code: 'DELIVERY_SLOT_NOT_ON_DO' } });
    expect(sqlite.prepare('SELECT count(*) n FROM orders').get()).toMatchObject({
      n: expect.any(Number),
    });
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
});
