/**
 * Pro-rata GL adjustment for PARTIAL returns.
 *
 * A FULL refund reverses the whole sale journal (refund-posting mirrors the
 * original entries). A PARTIAL return used to post NOTHING — the ledger kept
 * the full sale revenue and COGS while the goods came back (documented
 * residual of the #1134 partial-return work). This suite locks in the new
 * behavior:
 *
 *   - a partial return posts a pro-rata adjustment entry reversing only the
 *     returned lines (revenue = line price × qty returned, less the pro-rata
 *     discount share; tax pro-rata by returned gross over subtotal; COGS =
 *     line cost × qty returned), mirroring the full-refund journal's account
 *     selection and sign conventions (DR revenue/tax, CR cash; DR inventory,
 *     CR COGS). Shipping is NOT reversed on a partial — the order shipped
 *     and the customer kept part of it.
 *   - idempotent per refundKey (the Return id) — a redelivered event never
 *     posts twice.
 *   - prior returned quantities come from COMPLETED Return rows (the
 *     canonical business record, committed by ReturnService.complete BEFORE
 *     it fires order/refunded) — not from the inventory fanout's
 *     partial_return_restored marker, which the GL does not own (#1189).
 *   - discount/tax pro-rata telescopes across multiple partial returns via
 *     cumulative floor allocation, so the rounding remainder is allocated
 *     deterministically and the totals reverse EXACTLY when every unit has
 *     been returned — nothing dropped, nothing double-counted.
 *   - a later FULL refund reverses the original entries AND the partial
 *     adjustment entries, so the ledger nets to zero instead of
 *     double-reversing. The two paths contend on the same sale-entry row
 *     lock, so a full reversal running concurrently with a partial posting
 *     can never snapshot past it (#1187).
 *   - the VAT report counts partial-return tax reversals exactly once, as
 *     negative rows in the period they post (#1188).
 *
 * DB-direct integration test, mirrors accounting-refund.test.ts /
 * partial-return-refund-effects.test.ts: self-skips without a real
 * DATABASE_URL, unique suffix, cleans up in afterAll.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { prisma, withRlsBypass, runInTenantContext } from '@ebda/database';
import { seedCoaForStore } from '../../../apps/api/src/services/accounting/account.service';
import { postOrderPaymentJournal as postOrderPaymentJournalRaw } from '../../../apps/api/src/services/accounting/posting/order-posting';
import { postRefundJournal as postRefundJournalRaw } from '../../../apps/api/src/services/accounting/posting/refund-posting';
import { postPartialReturnJournal as postPartialReturnJournalRaw } from '../../../apps/api/src/services/accounting/posting/partial-return-posting';
import { generateTaxReport } from '../../../apps/api/src/services/accounting/tax-report.service';
import { ReturnService } from '../../../apps/api/src/services/return.service';
import { OrderService } from '../../../apps/api/src/services/order.service';

const hasDb =
  !!process.env.DATABASE_URL && !process.env.DATABASE_URL.includes('localhost:5432/test_db');

const OWNER = '00000000-0000-0000-0000-0000000000ab';
const CUSTOMER = '00000000-0000-0000-0000-0000000000ac';
let storeId: string;
// Production runs these inside runInTenantContext(storeId); the tenant guard
// needs the same ambient store here.
const postOrderPaymentJournal = (a: Parameters<typeof postOrderPaymentJournalRaw>[0]) =>
  runInTenantContext(storeId, () => postOrderPaymentJournalRaw(a));
const postRefundJournal = (a: Parameters<typeof postRefundJournalRaw>[0]) =>
  runInTenantContext(storeId, () => postRefundJournalRaw(a));
const postPartialReturnJournal = (a: Parameters<typeof postPartialReturnJournalRaw>[0]) =>
  runInTenantContext(storeId, () => postPartialReturnJournalRaw(a));
let productAId: string;
let productBId: string;
// COA account ids, resolved once in beforeAll
let acct: Record<'cashKnet' | 'taxPayable' | 'revenue' | 'shipping' | 'cogs' | 'inventory', string>;

/** Per-account net (debit - credit) across a set of entries. */
async function accountNets(entryIds: string[]): Promise<Map<string, number>> {
  const lines = await prisma.journalLine.findMany({
    where: { entryId: { in: entryIds } },
    select: { accountId: true, debit: true, credit: true },
  });
  const nets = new Map<string, number>();
  for (const l of lines) {
    nets.set(l.accountId, (nets.get(l.accountId) ?? 0) + l.debit - l.credit);
  }
  return nets;
}

async function orderEntries(orderId: string) {
  return prisma.journalEntry.findMany({
    where: { storeId, source: 'order', sourceId: { startsWith: orderId } },
    include: { lines: true },
    orderBy: { createdAt: 'asc' },
  });
}

/**
 * Seed an order with two items:
 *   A: price 2000 × 3 (cost 1000)  → gross 6000
 *   B: price 1500 × 2 (cost  700)  → gross 3000
 * subtotal 9000, discount 1000, tax 900, shipping 500, total 9400.
 */
async function seedOrder(tag: string, overrides?: { discount?: number; tax?: number }) {
  const discount = overrides?.discount ?? 1000;
  const tax = overrides?.tax ?? 900;
  const order = await prisma.order.create({
    data: {
      storeId,
      orderNumber: `PGL-${tag}-${Date.now()}`,
      status: 'delivered',
      paymentStatus: 'paid',
      customerId: CUSTOMER,
      subtotal: 9000,
      tax,
      shipping: 500,
      discount,
      total: 9000 - discount + tax + 500,
      currency: 'EGP',
      shippingAddress: {},
      billingAddress: {},
      items: {
        create: [
          {
            productId: productAId,
            productName: 'Partial GL Product A',
            quantity: 3,
            price: 2000,
            total: 6000,
            costPrice: 1000,
          },
          {
            productId: productBId,
            productName: 'Partial GL Product B',
            quantity: 2,
            price: 1500,
            total: 3000,
            costPrice: 700,
          },
        ],
      },
      payments: {
        create: [
          {
            provider: 'paymob',
            status: 'completed',
            amount: 9000 - discount + tax + 500,
            paidAt: new Date(),
          },
        ],
      },
    },
    include: { items: true },
  });
  const itemA = order.items.find(i => i.productId === productAId)!;
  const itemB = order.items.find(i => i.productId === productBId)!;
  return { order, itemA, itemB };
}

/**
 * Create a COMPLETED Return row for the order — the canonical record the GL
 * reads prior returned quantities (and the memo reason) from, exactly as
 * ReturnService.complete leaves it before firing order/refunded.
 */
async function createCompletedReturn(
  order: { id: string },
  items: Array<{
    orderItemId: string;
    productId: string;
    quantity: number;
    /** B2B Task 8b: the persisted tier adjustment of this item (signed piastres). */
    tierAdjustment?: number;
  }>,
  reason = 'defective'
): Promise<string> {
  const ret = await prisma.return.create({
    data: {
      storeId,
      orderId: order.id,
      customerId: CUSTOMER,
      returnNumber: `RET-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      type: 'return',
      status: 'completed',
      reason,
      refundedAt: new Date(),
      items: {
        create: items.map(i => ({
          orderItemId: i.orderItemId,
          productId: i.productId,
          productName: 'Partial GL Product',
          quantity: i.quantity,
          tierAdjustment: i.tierAdjustment ?? 0,
        })),
      },
    },
    select: { id: true },
  });
  return ret.id;
}

beforeAll(async () => {
  if (!hasDb) return;
  await prisma.user.upsert({
    where: { id: OWNER },
    update: {},
    create: {
      id: OWNER,
      email: `partial-gl-owner-${Date.now()}@example.test`,
      passwordHash: 'x',
      firstName: 'PartialGl',
      lastName: 'Owner',
    },
  });
  await prisma.user.upsert({
    where: { id: CUSTOMER },
    update: {},
    create: {
      id: CUSTOMER,
      email: `partial-gl-customer-${Date.now()}@example.test`,
      passwordHash: 'x',
      firstName: 'PartialGl',
      lastName: 'Customer',
      role: 'customer',
    },
  });
  const store = await prisma.store.create({
    data: {
      name: `partial-gl-test-${Date.now()}`,
      slug: `partial-gl-test-${Date.now()}`,
      ownerId: OWNER,
    },
  });
  storeId = store.id;
  await seedCoaForStore(storeId);

  const codes: Array<[keyof typeof acct, string]> = [
    ['cashKnet', '1000'],
    ['inventory', '1200'],
    ['taxPayable', '2100'],
    ['revenue', '4000'],
    ['shipping', '4010'],
    ['cogs', '5000'],
  ];
  acct = {} as typeof acct;
  for (const [key, code] of codes) {
    const a = await prisma.account.findUnique({
      where: { storeId_code: { storeId, code } },
      select: { id: true },
    });
    if (!a) throw new Error(`COA code ${code} missing after seed`);
    acct[key] = a.id;
  }

  const pa = await prisma.product.create({
    data: {
      storeId,
      name: 'Partial GL Product A',
      slug: `partial-gl-a-${Date.now()}`,
      price: 2000,
      costPrice: 1000,
      inventory: 50,
      status: 'active',
    },
  });
  productAId = pa.id;
  const pb = await prisma.product.create({
    data: {
      storeId,
      name: 'Partial GL Product B',
      slug: `partial-gl-b-${Date.now()}`,
      price: 1500,
      costPrice: 700,
      inventory: 50,
      status: 'active',
    },
  });
  productBId = pb.id;
});

afterAll(async () => {
  if (!hasDb || !storeId) return;
  await prisma.journalLine.deleteMany({ where: { entry: { storeId } } });
  await prisma.journalEntry.deleteMany({ where: { storeId } });
  await prisma.sequence.deleteMany({ where: { storeId } });
  await prisma.orderEvent.deleteMany({ where: { storeId } });
  await prisma.returnItem.deleteMany({ where: { return: { storeId } } });
  await prisma.return.deleteMany({ where: { storeId } });
  await prisma.orderItem.deleteMany({ where: { order: { storeId } } });
  await prisma.payment.deleteMany({ where: { order: { storeId } } });
  await prisma.order.deleteMany({ where: { storeId } });
  await prisma.product.deleteMany({ where: { storeId } });
  await prisma.account.deleteMany({ where: { storeId } });
  await prisma.store.delete({ where: { id: storeId } });
});

describe.skipIf(!hasDb)('partial-return pro-rata GL adjustment', () => {
  it('B2B tier adjustment: the journal books the ADJUSTED value, and a later release telescopes to the unadjusted total', async () => {
    const { order, itemA, itemB } = await seedOrder('TADJ');
    await postOrderPaymentJournal({ orderId: order.id });

    // 1 of A returned, 1000 retained (kept units repriced below their tier): credited gross 2000 - 1000 = 1000
    const r1 = await createCompletedReturn(order, [
      { orderItemId: itemA.id, productId: productAId, quantity: 1, tierAdjustment: 1000 },
    ]);
    await postPartialReturnJournal({
      orderId: order.id,
      refundKey: r1,
      items: [{ orderItemId: itemA.id, quantity: 1 }],
    });
    const e1 = await prisma.journalEntry.findFirstOrThrow({
      where: { storeId, source: 'order', sourceId: `${order.id}:partial:${r1}` },
      include: { lines: true },
    });
    // discount share by the RETURNED gross, floor(1000x2000/9000) = 222 (final review P2-2: the adjustment re-prices kept
    // units, it does not shrink the discount the returned unit received); tax share by credited gross floor(900x1000/9000) = 100
    expect(e1.lines.find(l => l.accountId === acct.revenue)?.debit).toBe(778);
    expect(e1.lines.find(l => l.accountId === acct.taxPayable)?.debit).toBe(100);
    expect(e1.lines.find(l => l.accountId === acct.cashKnet)?.credit).toBe(878); // unadjusted would be 1978

    // everything else comes back and releases the 1000: the cash credits add up to the whole order's goods
    const r2 = await createCompletedReturn(order, [
      { orderItemId: itemA.id, productId: productAId, quantity: 2, tierAdjustment: -1000 },
      { orderItemId: itemB.id, productId: productBId, quantity: 2 },
    ]);
    await postPartialReturnJournal({
      orderId: order.id,
      refundKey: r2,
      items: [
        { orderItemId: itemA.id, quantity: 2 },
        { orderItemId: itemB.id, quantity: 2 },
      ],
    });
    const e2 = await prisma.journalEntry.findFirstOrThrow({
      where: { storeId, source: 'order', sourceId: `${order.id}:partial:${r2}` },
      include: { lines: true },
    });
    // credited gross 7000 + 1000 released = 8000, discount 1000 - 222 = 778, tax 900 - 100 = 800
    expect(e2.lines.find(l => l.accountId === acct.cashKnet)?.credit).toBe(8022);
    expect(878 + 8022).toBe(9000 - 1000 + 900); // subtotal - discount + tax: the order's goods, nothing dropped, nothing doubled
  });

  // ---- final review P2-2 + Ruling B2B-17: the GL, the provider-side refund and the persisted adjustment are ONE number ----
  /**
   * A: tier-priced note-lines 5 + 5 @ 800 (list 1000, tier 10+ @ 800) = 8000; B: base 1 x 1000 that took a 20% coupon (200).
   * subtotal 9000, discount 200, tax 0, total 8800.
   */
  async function seedTierOrder(tag: string) {
    const ladder = {
      rungs: [{ minQty: 10, priceMinor: 800, variant: false, group: false }],
      groupPercentMinor: null,
    };
    const tierLine = (name: string) => ({
      productId: productAId,
      productName: name,
      quantity: 5,
      price: 800,
      total: 4000,
      costPrice: 400,
      listPrice: 1000,
      priceSource: 'tier',
      priceTierMinQty: 10,
      tierLadder: ladder,
    });
    const order = await prisma.order.create({
      data: {
        storeId,
        orderNumber: `PGL-${tag}-${Date.now()}`,
        status: 'delivered',
        paymentStatus: 'paid',
        customerId: CUSTOMER,
        subtotal: 9000,
        tax: 0,
        shipping: 0,
        discount: 200,
        total: 8800,
        currency: 'EGP',
        shippingAddress: {},
        billingAddress: {},
        items: {
          create: [
            tierLine('A1'),
            tierLine('A2'),
            {
              productId: productBId,
              productName: 'B',
              quantity: 1,
              price: 1000,
              total: 1000,
              costPrice: 500,
              listPrice: 1000,
              priceSource: 'base',
            },
          ],
        },
        payments: {
          create: [{ provider: 'paymob', status: 'completed', amount: 8800, paidAt: new Date() }],
        },
      },
      include: { items: true },
    });
    const by = (n: string) => order.items.find(i => i.productName === n)!;
    return { order, a1: by('A1'), a2: by('A2'), b: by('B') };
  }
  /** Complete a return through ReturnService (cash), then post its journal the way order/refunded would. */
  async function completeAndPost(
    orderId: string,
    items: Array<{ orderItemId: string; productId: string; quantity: number }>
  ) {
    const ret = await prisma.return.create({
      data: {
        storeId,
        orderId,
        customerId: CUSTOMER,
        returnNumber: `RET-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        type: 'return',
        status: 'received',
        reason: 'defective',
        items: { create: items.map(i => ({ ...i, productName: 'x' })) },
      },
      select: { id: true },
    });
    const effects = vi.spyOn(OrderService, 'applyRefundEffects').mockResolvedValue(undefined);
    const done = await ReturnService.complete(storeId, ret.id, 'staff-1', 'cash');
    effects.mockRestore();
    await postPartialReturnJournal({
      orderId,
      refundKey: ret.id,
      items: items.map(i => ({ orderItemId: i.orderItemId, quantity: i.quantity })),
    });
    // A zero refund (the floor bit, Ruling B2B-20) posts no cash entry; every other case asserts a non-zero cash credit.
    const entry = (await prisma.journalEntry.findFirst({
      where: { storeId, source: 'order', sourceId: `${orderId}:partial:${ret.id}` },
      include: { lines: true },
    })) ?? { lines: [] as Array<{ accountId: string; debit: number; credit: number }> };
    const adj = await prisma.returnItem.aggregate({
      where: { returnId: ret.id },
      _sum: { tierAdjustment: true },
    });
    return {
      refund: done.refundAmount,
      cash: entry.lines.find(l => l.accountId === acct.cashKnet)?.credit ?? 0,
      revenue: entry.lines.find(l => l.accountId === acct.revenue)?.debit ?? 0,
      adjustment: adj._sum.tierAdjustment ?? 0,
    };
  }

  it('P2-2: a tier line returned from a mixed coupon cart refunds in full; the base line takes back the whole coupon; GL == refund', async () => {
    const { order, a1, a2, b } = await seedTierOrder('P22');
    await postOrderPaymentJournal({ orderId: order.id });
    const r1 = await completeAndPost(order.id, [
      { orderItemId: a1.id, productId: productAId, quantity: 5 },
      { orderItemId: a2.id, productId: productAId, quantity: 5 },
    ]);
    // all 10 tier units back: nothing kept, no adjustment, and no share of a coupon the tier line never had
    expect(r1).toEqual({ refund: 8000, cash: 8000, revenue: 8000, adjustment: 0 }); // was 7823
    const r2 = await completeAndPost(order.id, [
      { orderItemId: b.id, productId: productBId, quantity: 1 },
    ]);
    expect(r2).toMatchObject({ refund: 800, cash: 800 });
    expect(r1.cash + r2.cash).toBe(8800);
  });

  it('B2B-17 in the GL: return one of two 5-unit note-lines (tier 10+) -> 1000 retained, then the rest releases it; cash credits == refunds == 8800', async () => {
    const { order, a1, a2, b } = await seedTierOrder('B217');
    await postOrderPaymentJournal({ orderId: order.id });
    const r1 = await completeAndPost(order.id, [
      { orderItemId: a1.id, productId: productAId, quantity: 5 },
    ]);
    // kept 5 of the product < 10: the 5 on A2 are repriced at 1000, adjustment 1000, refund 4000 - 1000
    expect(r1).toEqual({ refund: 3000, cash: 3000, revenue: 3000, adjustment: 1000 });
    const r2 = await completeAndPost(order.id, [
      { orderItemId: a2.id, productId: productAId, quantity: 5 },
      { orderItemId: b.id, productId: productBId, quantity: 1 },
    ]);
    // release 1000 on A2 (4000 + 1000) + B 1000 - its 200 coupon
    expect(r2).toMatchObject({ refund: 5800, cash: 5800, adjustment: -1000 });
    expect(r1.cash + r2.cash).toBe(8800);
  });

  it('B2B-20 in the GL: return 1 of 5 + 5 (tier 10+) -> refund 0 and 1000 carried; 4 more -> the carry is collected (3000, was 4000); the rest -> cash credits == refunds == 8800', async () => {
    const { order, a1, a2, b } = await seedTierOrder('B220');
    await postOrderPaymentJournal({ orderId: order.id });
    const r1 = await completeAndPost(order.id, [
      { orderItemId: a1.id, productId: productAId, quantity: 1 },
    ]);
    // 9 kept < 10: raw 1800, the 800 refund floors at 0, 1000 carried forward
    expect(r1).toEqual({ refund: 0, cash: 0, revenue: 0, adjustment: 800 });
    const r2 = await completeAndPost(order.id, [
      { orderItemId: a1.id, productId: productAId, quantity: 4 },
    ]);
    // 5 kept: raw -800 + 1000 carried = 200 collected from the 3200 standard refund
    expect(r2).toEqual({ refund: 3000, cash: 3000, revenue: 3000, adjustment: 200 });
    const r3 = await completeAndPost(order.id, [
      { orderItemId: a2.id, productId: productAId, quantity: 5 },
      { orderItemId: b.id, productId: productBId, quantity: 1 },
    ]);
    // release the 1000 retained on A (4000 + 1000) + B 1000 less its 200 coupon
    expect(r3).toMatchObject({ refund: 5800, cash: 5800, adjustment: -1000 });
    expect(r1.cash + r2.cash + r3.cash).toBe(8800);
  });

  it('posts a balanced pro-rata adjustment for a partial return, mirroring full-refund conventions', async () => {
    const { order, itemA } = await seedOrder('T1');
    await postOrderPaymentJournal({ orderId: order.id });

    const refundKey = await createCompletedReturn(order, [
      { orderItemId: itemA.id, productId: productAId, quantity: 1 },
    ]);
    const result = await postPartialReturnJournal({
      orderId: order.id,
      refundKey,
      items: [{ orderItemId: itemA.id, quantity: 1 }],
    });
    expect(result.posted).toBe(2); // revenue adjustment + COGS adjustment

    // Revenue/cash adjustment entry:
    //   returned gross = 2000; discount share = floor(1000×2000/9000) = 222
    //   tax share      = floor(900×2000/9000) = 200
    //   DR revenue 1778, DR tax 200, CR cash 1978 (paymob → 1000 Cash Online)
    const adj = await prisma.journalEntry.findFirst({
      where: { storeId, source: 'order', sourceId: `${order.id}:partial:${refundKey}` },
      include: { lines: true },
    });
    expect(adj).toBeTruthy();
    expect(adj!.status).toBe('posted');
    // Memo carries the merchant-entered return reason from the Return row
    // (issue 1191 — the event payload has no reason field to read).
    expect(adj!.memo).toBe(`Partial return — Order ${order.orderNumber} (defective)`);
    expect(adj!.lines).toHaveLength(3);
    const revLine = adj!.lines.find(l => l.accountId === acct.revenue);
    const taxLine = adj!.lines.find(l => l.accountId === acct.taxPayable);
    const cashLine = adj!.lines.find(l => l.accountId === acct.cashKnet);
    expect(revLine?.debit).toBe(1778);
    expect(revLine?.credit).toBe(0);
    expect(taxLine?.debit).toBe(200);
    expect(cashLine?.credit).toBe(1978);
    // Balanced, and shipping never touched on a partial
    const dr = adj!.lines.reduce((s, l) => s + l.debit, 0);
    const cr = adj!.lines.reduce((s, l) => s + l.credit, 0);
    expect(dr).toBe(cr);
    expect(adj!.lines.find(l => l.accountId === acct.shipping)).toBeUndefined();

    // COGS adjustment entry: DR inventory 1000 / CR COGS 1000
    const cogsAdj = await prisma.journalEntry.findFirst({
      where: { storeId, source: 'order', sourceId: `${order.id}:partial:${refundKey}:cogs` },
      include: { lines: true },
    });
    expect(cogsAdj).toBeTruthy();
    const invLine = cogsAdj!.lines.find(l => l.accountId === acct.inventory);
    const cogsLine = cogsAdj!.lines.find(l => l.accountId === acct.cogs);
    expect(invLine?.debit).toBe(1000);
    expect(cogsLine?.credit).toBe(1000);

    // Originals stay posted — a partial return must NOT reverse the sale
    const cashOriginal = await prisma.journalEntry.findFirst({
      where: { storeId, source: 'order', sourceId: order.id },
    });
    const cogsOriginal = await prisma.journalEntry.findFirst({
      where: { storeId, source: 'order', sourceId: `${order.id}:cogs` },
    });
    expect(cashOriginal?.status).toBe('posted');
    expect(cogsOriginal?.status).toBe('posted');
  });

  it('is idempotent per refundKey — a redelivered event never posts twice', async () => {
    const { order, itemA } = await seedOrder('T2');
    await postOrderPaymentJournal({ orderId: order.id });
    const refundKey = await createCompletedReturn(order, [
      { orderItemId: itemA.id, productId: productAId, quantity: 1 },
    ]);
    const first = await postPartialReturnJournal({
      orderId: order.id,
      refundKey,
      items: [{ orderItemId: itemA.id, quantity: 1 }],
    });
    expect(first.posted).toBe(2);

    const before = await prisma.journalEntry.count({ where: { storeId } });
    const again = await postPartialReturnJournal({
      orderId: order.id,
      refundKey,
      items: [{ orderItemId: itemA.id, quantity: 1 }],
    });
    expect(again.posted).toBe(0);
    const after = await prisma.journalEntry.count({ where: { storeId } });
    expect(after).toBe(before);
  });

  it('telescopes discount/tax pro-rata across returns — exact totals when everything comes back', async () => {
    const { order, itemA, itemB } = await seedOrder('T3');
    await postOrderPaymentJournal({ orderId: order.id });

    // Return 1: 1× A — completed Return row committed before its GL posts,
    // exactly as ReturnService.complete sequences it.
    const ret1 = await createCompletedReturn(order, [
      { orderItemId: itemA.id, productId: productAId, quantity: 1 },
    ]);
    await postPartialReturnJournal({
      orderId: order.id,
      refundKey: ret1,
      items: [{ orderItemId: itemA.id, quantity: 1 }],
    });

    // Return 2: everything else (2× A + 2× B, gross 7000, cum gross 9000).
    //   discount: 1000 total − 222 already = 778; tax: 900 − 200 = 700
    //   DR revenue 7000−778 = 6222, DR tax 700, CR cash 6922
    const ret2 = await createCompletedReturn(order, [
      { orderItemId: itemA.id, productId: productAId, quantity: 2 },
      { orderItemId: itemB.id, productId: productBId, quantity: 2 },
    ]);
    const result = await postPartialReturnJournal({
      orderId: order.id,
      refundKey: ret2,
      items: [
        { orderItemId: itemA.id, quantity: 2 },
        { orderItemId: itemB.id, quantity: 2 },
      ],
    });
    expect(result.posted).toBe(2);

    const adj2 = await prisma.journalEntry.findFirst({
      where: { storeId, source: 'order', sourceId: `${order.id}:partial:${ret2}` },
      include: { lines: true },
    });
    expect(adj2!.lines.find(l => l.accountId === acct.revenue)?.debit).toBe(6222);
    expect(adj2!.lines.find(l => l.accountId === acct.taxPayable)?.debit).toBe(700);
    expect(adj2!.lines.find(l => l.accountId === acct.cashKnet)?.credit).toBe(6922);

    // COGS of return 2: 2×1000 + 2×700 = 3400
    const cogsAdj2 = await prisma.journalEntry.findFirst({
      where: { storeId, source: 'order', sourceId: `${order.id}:partial:${ret2}:cogs` },
      include: { lines: true },
    });
    const cogsTotal = cogsAdj2!.lines.reduce((s, l) => s + l.credit, 0);
    expect(cogsTotal).toBe(3400);

    // Across BOTH returns the sale (minus shipping) reverses EXACTLY:
    //   revenue 1778+6222 = 8000 (= subtotal−discount), tax 200+700 = 900,
    //   cash 1978+6922 = 8900 (= total − shipping), COGS 1000+3400 = 4400.
    const partials = await prisma.journalEntry.findMany({
      where: { storeId, source: 'order', sourceId: { startsWith: `${order.id}:partial:` } },
      select: { id: true },
    });
    const nets = await accountNets(partials.map(e => e.id));
    expect(nets.get(acct.revenue)).toBe(8000);
    expect(nets.get(acct.taxPayable)).toBe(900);
    expect(nets.get(acct.cashKnet)).toBe(-8900);
    expect(nets.get(acct.cogs)).toBe(-4400);
    expect(nets.get(acct.inventory)).toBe(4400);
    expect(nets.get(acct.shipping) ?? 0).toBe(0);
  });

  it('clamps returned quantities to the un-returned remainder — an over-claim posts nothing', async () => {
    const { order, itemA, itemB } = await seedOrder('T4');
    await postOrderPaymentJournal({ orderId: order.id });

    // Everything already returned by two prior COMPLETED returns (rows only —
    // whether their own GL entries posted is irrelevant to the clamp).
    await createCompletedReturn(order, [
      { orderItemId: itemA.id, productId: productAId, quantity: 3 },
    ]);
    await createCompletedReturn(order, [
      { orderItemId: itemB.id, productId: productBId, quantity: 2 },
    ]);
    const ret3 = await createCompletedReturn(order, [
      { orderItemId: itemA.id, productId: productAId, quantity: 5 },
    ]);

    const before = await prisma.journalEntry.count({ where: { storeId } });
    const result = await postPartialReturnJournal({
      orderId: order.id,
      refundKey: ret3,
      items: [
        { orderItemId: itemA.id, quantity: 5 },
        { orderItemId: itemB.id, quantity: 1 },
      ],
    });
    expect(result.posted).toBe(0);
    const after = await prisma.journalEntry.count({ where: { storeId } });
    expect(after).toBe(before);
  });

  it('a later FULL refund reverses originals AND partial adjustments — ledger nets to zero, no double reversal', async () => {
    const { order, itemA } = await seedOrder('T5');
    await postOrderPaymentJournal({ orderId: order.id });

    const ret1 = await createCompletedReturn(order, [
      { orderItemId: itemA.id, productId: productAId, quantity: 1 },
    ]);
    await postPartialReturnJournal({
      orderId: order.id,
      refundKey: ret1,
      items: [{ orderItemId: itemA.id, quantity: 1 }],
    });

    // Whole order now cancelled/refunded → full reversal must cover the
    // 2 originals AND the 2 partial adjustment entries.
    const result = await postRefundJournal({
      orderId: order.id,
      reason: 'full refund after partial',
    });
    expect(result.reversed).toBe(4);

    const entries = await orderEntries(order.id);
    // 2 originals + 2 partial adjustments + 4 reversals
    expect(entries).toHaveLength(8);
    const nets = await accountNets(entries.map(e => e.id));
    for (const [accountId, net] of nets) {
      expect(net, `account ${accountId} must net to zero`).toBe(0);
    }

    // And re-firing is a no-op (idempotent at-least-once delivery)
    const again = await postRefundJournal({ orderId: order.id, reason: 'redelivery' });
    expect(again.reversed).toBe(0);
  });

  it('a concurrent full reversal cannot snapshot past an in-flight partial posting (issue 1187)', async () => {
    const { order, itemA } = await seedOrder('T8');
    await postOrderPaymentJournal({ orderId: order.id });
    const ret1 = await createCompletedReturn(order, [
      { orderItemId: itemA.id, productId: productAId, quantity: 1 },
    ]);

    // Post the partial adjustment inside an explicitly-held transaction: it
    // takes the sale-entry row lock, posts both adjustment entries, then
    // signals readiness and keeps the transaction OPEN for 400ms. The full
    // reversal fired in that window must contend on the same lock and, once
    // the partial commits, reverse all four entries — never just the two
    // originals it could snapshot before the partial committed.
    let release!: () => void;
    const gate = new Promise<void>(r => {
      release = r;
    });
    const partialDone = withRlsBypass(async tx => {
      const res = await postPartialReturnJournal({
        orderId: order.id,
        refundKey: ret1,
        items: [{ orderItemId: itemA.id, quantity: 1 }],
        tx,
      });
      expect(res.posted).toBe(2);
      release();
      await new Promise(r => setTimeout(r, 400));
    });
    await gate;
    const full = await postRefundJournal({ orderId: order.id, reason: 'concurrent full' });
    await partialDone;
    expect(full.reversed).toBe(4);

    const nets = await accountNets((await orderEntries(order.id)).map(e => e.id));
    for (const [accountId, net] of nets) {
      expect(net, `account ${accountId} must net to zero`).toBe(0);
    }
  });

  it('refuses a storeId that does not match the order (issue 1190)', async () => {
    const { order, itemA } = await seedOrder('T9');
    await postOrderPaymentJournal({ orderId: order.id });
    const ret1 = await createCompletedReturn(order, [
      { orderItemId: itemA.id, productId: productAId, quantity: 1 },
    ]);

    const wrongStore = '00000000-0000-0000-0000-00000000dead';
    const partial = await postPartialReturnJournal({
      orderId: order.id,
      refundKey: ret1,
      items: [{ orderItemId: itemA.id, quantity: 1 }],
      storeId: wrongStore,
    });
    expect(partial.posted).toBe(0);

    const full = await postRefundJournal({
      orderId: order.id,
      reason: 'wrong store',
      storeId: wrongStore,
    });
    expect(full.reversed).toBe(0);

    // Matching storeId works
    const ok = await postPartialReturnJournal({
      orderId: order.id,
      refundKey: ret1,
      items: [{ orderItemId: itemA.id, quantity: 1 }],
      storeId,
    });
    expect(ok.posted).toBe(2);
  });

  it('VAT report counts the partial-return tax reversal exactly once (issue 1188)', async () => {
    const { order, itemA } = await seedOrder('TAX1');
    await postOrderPaymentJournal({ orderId: order.id });
    const ret1 = await createCompletedReturn(order, [
      { orderItemId: itemA.id, productId: productAId, quantity: 1 },
    ]);
    await postPartialReturnJournal({
      orderId: order.id,
      refundKey: ret1,
      items: [{ orderItemId: itemA.id, quantity: 1 }],
    });

    const report = await generateTaxReport(storeId, {
      from: new Date('2000-01-01T00:00:00Z'),
      to: new Date(Date.now() + 86_400_000),
    });
    const rows = report.rows.filter(r => r.orderNumber === order.orderNumber);
    // Sale row (+900 on base 8000) AND the partial reversal row (−200 on
    // base −1778) — the returned tax must leave the declared figure.
    expect(rows).toHaveLength(2);
    const sale = rows.find(r => r.taxCollected > 0);
    const reversal = rows.find(r => r.taxCollected < 0);
    expect(sale?.taxCollected).toBe(900);
    expect(sale?.subtotal).toBe(8000);
    expect(reversal?.taxCollected).toBe(-200);
    expect(reversal?.subtotal).toBe(-1778);
    const netTax = rows.reduce((s, r) => s + r.taxCollected, 0);
    expect(netTax).toBe(700);
  });

  it('VAT report nets a refunded-after-partial order to zero without hiding history (issue 1188)', async () => {
    const { order, itemA } = await seedOrder('TAX2');
    await postOrderPaymentJournal({ orderId: order.id });
    const ret1 = await createCompletedReturn(order, [
      { orderItemId: itemA.id, productId: productAId, quantity: 1 },
    ]);
    await postPartialReturnJournal({
      orderId: order.id,
      refundKey: ret1,
      items: [{ orderItemId: itemA.id, quantity: 1 }],
    });
    await postRefundJournal({ orderId: order.id, reason: 'full refund' });

    const report = await generateTaxReport(storeId, {
      from: new Date('2000-01-01T00:00:00Z'),
      to: new Date(Date.now() + 86_400_000),
    });
    const rows = report.rows.filter(r => r.orderNumber === order.orderNumber);
    // Sale (+900), partial adjustment (−200), sale reversal (−900), partial
    // adjustment reversal (+200): every movement visible, net zero — the
    // sale row must NOT retroactively vanish from the period it was filed in.
    expect(rows).toHaveLength(4);
    expect(rows.reduce((s, r) => s + r.taxCollected, 0)).toBe(0);
    expect(rows.reduce((s, r) => s + r.subtotal, 0)).toBe(0);
    // #1253 / #1208: exactly one of the four is the sale, and only it carries
    // the order total, so the exported Order Total column counts the order
    // once. The +200 reversal-of-the-adjustment is a reversal row despite its
    // sign; the partial-return adjustment is the -200 one.
    expect(rows.filter(r => r.kind === 'sale')).toHaveLength(1);
    expect(rows.find(r => r.kind === 'sale')?.taxCollected).toBe(900);
    expect(rows.reduce((s, r) => s + (r.total ?? 0), 0)).toBe(order.total);
    expect(rows.filter(r => r.kind === 'reversal').every(r => r.total === null)).toBe(true);
    expect(
      rows
        .filter(r => r.kind === 'reversal')
        .map(r => r.taxCollected)
        .sort((a, b) => a - b)
    ).toEqual([-900, -200, 200]);
  });

  it('no-ops when the order never posted a sale journal', async () => {
    const order = await prisma.order.create({
      data: {
        storeId,
        orderNumber: `PGL-NOPOST-${Date.now()}`,
        status: 'pending',
        paymentStatus: 'unpaid',
        subtotal: 1000,
        tax: 0,
        shipping: 0,
        discount: 0,
        total: 1000,
        currency: 'EGP',
        shippingAddress: {},
        billingAddress: {},
        items: {
          create: [
            {
              productId: productAId,
              productName: 'Partial GL Product A',
              quantity: 1,
              price: 1000,
              total: 1000,
              costPrice: 500,
            },
          ],
        },
      },
      include: { items: true },
    });
    const result = await postPartialReturnJournal({
      orderId: order.id,
      refundKey: `ret1-${order.id}`,
      items: [{ orderItemId: order.items[0].id, quantity: 1 }],
    });
    expect(result.posted).toBe(0);
    const count = await prisma.journalEntry.count({
      where: { storeId, sourceId: { startsWith: order.id } },
    });
    expect(count).toBe(0);
  });

  it('no-ops a partial adjustment after the sale is already fully reversed', async () => {
    const { order, itemA } = await seedOrder('T7');
    await postOrderPaymentJournal({ orderId: order.id });
    await postRefundJournal({ orderId: order.id, reason: 'full refund' });

    const before = await prisma.journalEntry.count({ where: { storeId } });
    const result = await postPartialReturnJournal({
      orderId: order.id,
      refundKey: `late-ret-${order.id}`,
      items: [{ orderItemId: itemA.id, quantity: 1 }],
    });
    expect(result.posted).toBe(0);
    const after = await prisma.journalEntry.count({ where: { storeId } });
    expect(after).toBe(before);
  });
});
