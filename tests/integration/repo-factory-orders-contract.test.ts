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
          `INSERT OR IGNORE INTO customers (id, store_id, email, first_name, last_name) VALUES (?, ?, ?, 'Reader', 'One')`
        )
        .run(user.id, STORE, user.email);
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

  it('order search on a DO store is refused loudly (never answered empty)', async () => {
    const refused = await settle(() =>
      onDo(() => OrderService.list(STORE, { search: 'anything' }))
    );
    expect(refused).toMatchObject({ err: { status: 501, code: 'ORDER_SEARCH_NOT_ON_DO' } });
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
