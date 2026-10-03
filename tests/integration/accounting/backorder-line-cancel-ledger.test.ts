/**
 * Cancelling ONE backorder line reverses only THAT line in the ledger
 * (owner decision 2026-09-30, ruling AP-5).
 *
 * Before: `cancelBackorder` fired the WHOLE-order `order/refunded` event, so
 * the GL consumer reversed the entire sale of an order that was still live.
 * Now it fires the item-level event (`partial`, refundKey `backorder:<id>`)
 * and the GL posts a pro-rata adjustment through the partial-return path:
 * the line's revenue net of its discount share, its VAT share, its COGS.
 *
 * The event is captured at `OrderService.applyRefundEffects` and fed to
 * `postPartialReturnJournal` exactly as `accounting-post-refund-journal`
 * does with `event.data.partial` — so the payload the service builds is the
 * payload the ledger is tested with.
 *
 * DB-direct, self-skips without a real DATABASE_URL, per-call unique
 * fixtures (retry-safe), cleans up in afterAll.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { prisma, runInTenantContext } from '@force/database';
import { seedCoaForStore } from '../../../apps/api/src/services/accounting/account.service';
import { postOrderPaymentJournal } from '../../../apps/api/src/services/accounting/posting/order-posting';
import { postRefundJournal } from '../../../apps/api/src/services/accounting/posting/refund-posting';
import { postPartialReturnJournal } from '../../../apps/api/src/services/accounting/posting/partial-return-posting';
import { cancelBackorder } from '../../../apps/api/src/services/accounting/backorder.service';
import { OrderService } from '../../../apps/api/src/services/order.service';
import { handleOrderRefunded } from '../../../apps/api/src/lib/inngest/functions/order-refunded';

const hasDb =
  !!process.env.DATABASE_URL && !process.env.DATABASE_URL.includes('localhost:5432/test_db');

const OWNER = '00000000-0000-0000-0000-0000000000bd';
let storeId: string;
const productIds: string[] = [];
let acct: Record<'cash' | 'taxPayable' | 'revenue' | 'shipping' | 'cogs' | 'inventory', string>;

type Captured = {
  orderId: string;
  options: Parameters<typeof OrderService.applyRefundEffects>[2];
};
let captured: Captured[] = [];

function uid(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Three lines, every unit backordered:
 *   A 2000 × 2 (cost 1000) → 4000
 *   B 1500 × 1 (cost  700) → 1500
 *   C 1000 × 3 (cost  400) → 3000
 * subtotal 8500, discount 1000, tax 777 (exclusive), total 8277 + shipping.
 * Neither 1000 nor 777 splits evenly by line gross, so a per-line (non-
 * cumulative) allocation would leave piastres behind — the all-lines test catches it.
 */
async function seedOrder(opts: { shipping?: number; qtyFulfilledC?: number } = {}) {
  const shipping = opts.shipping ?? 0;
  const lines = [
    { i: 0, qty: 2, price: 2000, cost: 1000 },
    { i: 1, qty: 1, price: 1500, cost: 700 },
    { i: 2, qty: 3, price: 1000, cost: 400 },
  ];
  const total = 8500 - 1000 + 777 + shipping;
  const order = await prisma.order.create({
    data: {
      storeId,
      orderNumber: `BOL-${uid()}`,
      status: 'processing',
      paymentStatus: 'paid',
      subtotal: 8500,
      discount: 1000,
      tax: 777,
      shipping,
      total,
      currency: 'EGP',
      shippingAddress: {},
      billingAddress: {},
      items: {
        create: lines.map(l => ({
          productId: productIds[l.i],
          productName: `BO line ${l.i}`,
          quantity: l.qty,
          price: l.price,
          total: l.price * l.qty,
          costPrice: l.cost,
          costPriceDeferred: true,
        })),
      },
      payments: {
        create: [
          { provider: 'myfatoorah', status: 'completed', amount: total, paidAt: new Date() },
        ],
      },
    },
    include: { items: true },
  });
  const items = lines.map(l => order.items.find(it => it.productId === productIds[l.i])!);
  const backorders = [];
  for (const [n, item] of items.entries()) {
    backorders.push(
      await prisma.backorderLine.create({
        data: {
          storeId,
          orderItemId: item.id,
          productId: item.productId,
          qty: item.quantity,
          qtyFulfilled: n === 2 ? (opts.qtyFulfilledC ?? 0) : 0,
        },
      })
    );
  }
  await postOrderPaymentJournal({ orderId: order.id });
  return { order, items, backorders };
}

/** Cancel through the service, then deliver the captured event to the GL. */
async function cancelAndPost(orderId: string, backorderId: string, reason = 'supplier dropped it') {
  await runInTenantContext(storeId, () => cancelBackorder(storeId, backorderId, reason, OWNER));
  const ev = captured.at(-1)!;
  expect(ev.orderId).toBe(orderId);
  const partial = ev.options!.partial!;
  return postPartialReturnJournal({
    orderId,
    storeId,
    refundKey: partial.refundKey,
    items: partial.items,
  });
}

async function orderNets(orderId: string): Promise<Map<string, number>> {
  const lines = await prisma.journalLine.findMany({
    where: { entry: { storeId, source: 'order', sourceId: { startsWith: orderId } } },
    select: { accountId: true, debit: true, credit: true },
  });
  const nets = new Map<string, number>();
  for (const l of lines) nets.set(l.accountId, (nets.get(l.accountId) ?? 0) + l.debit - l.credit);
  return nets;
}

function nonZero(nets: Map<string, number>): Record<string, number> {
  return Object.fromEntries([...nets].filter(([, v]) => v !== 0));
}

beforeAll(async () => {
  if (!hasDb) return;
  await prisma.user.upsert({
    where: { id: OWNER },
    update: {},
    create: {
      id: OWNER,
      email: `bol-owner-${uid()}@example.test`,
      passwordHash: 'x',
      firstName: 'Bol',
      lastName: 'Owner',
    },
  });
  const slug = `bol-test-${uid()}`;
  const store = await prisma.store.create({ data: { name: slug, slug, ownerId: OWNER } });
  storeId = store.id;
  await seedCoaForStore(storeId);
  const codes: Array<[keyof typeof acct, string]> = [
    ['cash', '1000'],
    ['inventory', '1200'],
    ['taxPayable', '2100'],
    ['revenue', '4000'],
    ['shipping', '4010'],
    ['cogs', '5000'],
  ];
  acct = {} as typeof acct;
  for (const [key, code] of codes) {
    const a = await prisma.account.findUniqueOrThrow({
      where: { storeId_code: { storeId, code } },
      select: { id: true },
    });
    acct[key] = a.id;
  }
  for (const i of [0, 1, 2]) {
    const p = await prisma.product.create({
      data: {
        storeId,
        name: `BO product ${i}`,
        slug: `bol-p${i}-${uid()}`,
        price: 1000,
        inventory: 0,
        allowBackorder: true,
        status: 'active',
      },
    });
    productIds.push(p.id);
  }
});

// tests/setup.ts restores every mock after each test — re-spy per test.
beforeEach(() => {
  if (!hasDb) return;
  captured = [];
  vi.spyOn(OrderService, 'applyRefundEffects').mockImplementation(async (_s, orderId, options) => {
    captured.push({ orderId, options });
  });
});

afterAll(async () => {
  if (!hasDb || !storeId) return;
  await prisma.journalLine.deleteMany({ where: { entry: { storeId } } });
  await prisma.journalEntry.deleteMany({ where: { storeId } });
  await prisma.sequence.deleteMany({ where: { storeId } });
  await prisma.orderEvent.deleteMany({ where: { storeId } });
  await prisma.backorderLine.deleteMany({ where: { storeId } });
  await prisma.orderItem.deleteMany({ where: { order: { storeId } } });
  await prisma.payment.deleteMany({ where: { order: { storeId } } });
  await prisma.order.deleteMany({ where: { storeId } });
  await prisma.product.deleteMany({ where: { storeId } });
  await prisma.account.deleteMany({ where: { storeId } });
  await prisma.store.delete({ where: { id: storeId } });
});

describe.skipIf(!hasDb)('backorder line cancel → line-only GL reversal', () => {
  it('3-line order, cancel 1 line → reverses exactly that line (revenue, VAT, COGS)', async () => {
    const { order, items, backorders } = await seedOrder();
    const result = await cancelAndPost(order.id, backorders[1].id);
    expect(result).toEqual({ posted: 2 });

    // The event is item-level, never whole-order.
    const opts = captured[0].options!;
    expect(opts.restoreInventory).toBe(false);
    expect(opts.reverseWallet).toBe(false);
    expect(opts.partial).toEqual({
      items: [{ orderItemId: items[1].id, quantity: 1 }],
      refundKey: `backorder:${backorders[1].id}`,
      refundAmount: 1461,
      backorderLineId: backorders[1].id,
    });

    // B gross 1500: discount share floor(1000×1500/8500)=176, tax floor(777×1500/8500)=137
    const adj = await prisma.journalEntry.findFirstOrThrow({
      where: {
        storeId,
        source: 'order',
        sourceId: `${order.id}:partial:backorder:${backorders[1].id}`,
      },
      include: { lines: true },
    });
    expect(adj.memo).toBe(
      `Backorder line cancelled — Order ${order.orderNumber} (supplier dropped it)`
    );
    const by = (id: string) => adj.lines.find(l => l.accountId === id);
    expect(by(acct.revenue)?.debit).toBe(1324);
    expect(by(acct.taxPayable)?.debit).toBe(137);
    expect(by(acct.cash)?.credit).toBe(1461);
    expect(adj.lines).toHaveLength(3);

    const cogs = await prisma.journalEntry.findFirstOrThrow({
      where: {
        storeId,
        source: 'order',
        sourceId: `${order.id}:partial:backorder:${backorders[1].id}:cogs`,
      },
      include: { lines: true },
    });
    expect(cogs.lines.find(l => l.accountId === acct.inventory)?.debit).toBe(700);
    expect(cogs.lines.find(l => l.accountId === acct.cogs)?.credit).toBe(700);

    // The sale itself still stands — the other two lines are still owed.
    const originals = await prisma.journalEntry.findMany({
      where: { storeId, source: 'order', sourceId: { in: [order.id, `${order.id}:cogs`] } },
      select: { status: true },
    });
    expect(originals.map(o => o.status)).toEqual(['posted', 'posted']);

    // Net of the order = sale of A + C only.
    const nets = await orderNets(order.id);
    expect(nets.get(acct.cash)).toBe(8277 - 1461);
    expect(nets.get(acct.revenue)).toBe(-(8500 - 1000) + 1324);
    expect(nets.get(acct.taxPayable)).toBe(-777 + 137);
    expect(nets.get(acct.cogs)).toBe(2 * 1000 + 3 * 400);

    // Only the cancelled line changed; the others stay open.
    const open = await prisma.backorderLine.findMany({
      where: { id: { in: [backorders[0].id, backorders[2].id] } },
      select: { cancelledAt: true },
    });
    expect(open.every(b => b.cancelledAt === null)).toBe(true);
  });

  it('cancelling every line one by one nets to exactly a full reversal', async () => {
    const { order, backorders } = await seedOrder();
    // Twin order, reversed whole — the reference.
    const twin = await seedOrder();
    await postRefundJournal({ orderId: twin.order.id, storeId });

    for (const bo of [backorders[2], backorders[0], backorders[1]]) {
      await cancelAndPost(order.id, bo.id);
    }
    const nets = await orderNets(order.id);
    const twinNets = await orderNets(twin.order.id);
    // Every account nets to zero on both — the cumulative allocation leaves
    // no fil of discount or tax behind (1000/777 do not split evenly by line).
    expect(nonZero(twinNets)).toEqual({});
    expect(nonZero(nets)).toEqual({});
  });

  it('with shipping, cancelling every line leaves only the shipping charge (documented residual)', async () => {
    const { order, backorders } = await seedOrder({ shipping: 500 });
    for (const bo of backorders) await cancelAndPost(order.id, bo.id);
    const nets = nonZero(await orderNets(order.id));
    expect(nets).toEqual({ [acct.cash]: 500, [acct.shipping]: -500 });
  });

  it('cancelling the same line twice never double-reverses', async () => {
    const { order, backorders } = await seedOrder();
    await cancelAndPost(order.id, backorders[0].id);
    const before = await prisma.journalEntry.count({ where: { storeId } });

    // Second cancel of the same line → 404, no second event.
    await expect(
      runInTenantContext(storeId, () => cancelBackorder(storeId, backorders[0].id, 'again', OWNER))
    ).rejects.toMatchObject({ statusCode: 404 });
    expect(captured).toHaveLength(1);

    // At-least-once redelivery of the SAME event → already-posted.
    const partial = captured[0].options!.partial!;
    const redelivered = await postPartialReturnJournal({
      orderId: order.id,
      storeId,
      refundKey: partial.refundKey,
      items: partial.items,
    });
    expect(redelivered).toEqual({ posted: 0, skipped: 'already-posted' });
    expect(await prisma.journalEntry.count({ where: { storeId } })).toBe(before);

    // Exactly one cancellation marker for the line.
    const markers = await prisma.orderEvent.count({
      where: { storeId, orderId: order.id, toStatus: 'backorder_line_cancelled' },
    });
    expect(markers).toBe(1);
  });

  it('a partly-fulfilled line reverses only its unfulfilled units', async () => {
    const { order, items, backorders } = await seedOrder({ qtyFulfilledC: 1 });
    await cancelAndPost(order.id, backorders[2].id);
    expect(captured[0].options!.partial!.items).toEqual([
      { orderItemId: items[2].id, quantity: 2 },
    ]);
    const cogs = await prisma.journalEntry.findFirstOrThrow({
      where: {
        storeId,
        source: 'order',
        sourceId: `${order.id}:partial:backorder:${backorders[2].id}:cogs`,
      },
      include: { lines: true },
    });
    expect(cogs.lines.find(l => l.accountId === acct.cogs)?.credit).toBe(800);
  });

  it('full-order cancel is unchanged: reverses the whole sale, backing out line adjustments first', async () => {
    // Untouched order: exactly the two originals are reversed, as before.
    const plain = await seedOrder({ shipping: 500 });
    expect(await postRefundJournal({ orderId: plain.order.id, storeId })).toEqual({ reversed: 2 });
    expect(nonZero(await orderNets(plain.order.id))).toEqual({});

    // After one line cancel: originals + that line's two adjustments reversed.
    const { order, backorders } = await seedOrder({ shipping: 500 });
    await cancelAndPost(order.id, backorders[1].id);
    expect(await postRefundJournal({ orderId: order.id, storeId })).toEqual({ reversed: 4 });
    expect(nonZero(await orderNets(order.id))).toEqual({});
  });
  it("the fanout leaves the item's OTHER open backorder lines open", async () => {
    const { order, items, backorders } = await seedOrder();
    // A second shortfall line on item A (bundle pairing can produce several).
    const sibling = await prisma.backorderLine.create({
      data: { storeId, orderItemId: items[0].id, productId: items[0].productId, qty: 1 },
    });
    await runInTenantContext(storeId, () => cancelBackorder(storeId, backorders[0].id, 'r', OWNER));
    const opts = captured[0].options!;
    const stepStub = { run: <T>(_id: string, fn: () => Promise<T>) => fn() };
    await handleOrderRefunded(
      order.id,
      storeId,
      opts.restoreInventory ?? true,
      false, // notify: keep the notification block out of this DB test
      stepStub,
      opts.partial,
      opts.reverseWallet ?? true
    );
    const after = await prisma.backorderLine.findUniqueOrThrow({
      where: { id: sibling.id },
      select: { cancelledAt: true },
    });
    expect(after.cancelledAt).toBeNull();
    // No whole-order completion stamp either.
    const o = await prisma.order.findUniqueOrThrow({
      where: { id: order.id },
      select: { refundReversedAt: true },
    });
    expect(o.refundReversedAt).toBeNull();
  });

  // Issue 2276: the claim + marker ride the request's transaction. When that
  // transaction rolls back, the line stays open and no marker survives — so
  // the dropped deferred event does not strand a cancelled-but-unposted line.
  // Mutation proof: run the claim on `withMoneyTx` unconditionally → the line
  // is committed cancelled despite the rollback and this goes red.
  it('a rolled-back request leaves the line open and writes no marker', async () => {
    const { order, backorders } = await seedOrder();
    await expect(
      runInTenantContext(storeId, async () => {
        await cancelBackorder(storeId, backorders[0].id, 'r', OWNER);
        throw new Error('request rolled back');
      })
    ).rejects.toThrow('request rolled back');
    const line = await prisma.backorderLine.findUniqueOrThrow({
      where: { id: backorders[0].id },
      select: { cancelledAt: true },
    });
    expect(line.cancelledAt).toBeNull();
    const markers = await prisma.orderEvent.count({
      where: { orderId: order.id, toStatus: 'backorder_line_cancelled' },
    });
    expect(markers).toBe(0);
  });
});
