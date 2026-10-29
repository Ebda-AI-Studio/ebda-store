/**
 * Owner money decisions of 2026-10-01 (Ahmad), one block per decision:
 *
 *  1. #2078 — a disabled variant that still holds units is EXCLUDED from stock
 *     value, and disabling it posts NO journal entry. Every stock-value reader
 *     agrees: finance dashboard + analytics snapshot (one query,
 *     storeStockValueFils), inventory page, dead stock.
 *  2. #1207 / #1351 — a partial return's credit follows the refund method, for
 *     the amount actually refunded: card/gateway → the sale's cash/gateway
 *     clearing account, wallet → 2150, off-platform store credit → 2160.
 *  3. #1209 / #1455 — a partial refund made outside a return is a revenue
 *     refund for exactly that amount (DR 4090 / CR cash), no stock movement,
 *     idempotent per provider refund id, and backed out by a later full refund.
 *  4. #1956 — a partial gateway refund on an order paid partly from the wallet
 *     is split pro-rata to the payment mix; piastres rounding goes to the card.
 *
 * Amounts are chosen so nothing divides evenly (1333 × 3 + 777 × 2, discount
 * 101, tax 277, shipping 250). Only the provider is stubbed
 * (`V2ProviderBridge.prototype.refund`) and the Inngest send. Self-skips
 * without a real DATABASE_URL; every fixture id is per call (retry-safe).
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { prisma, runInTenantContext, withRlsBypass } from '@ebda/database';

vi.mock('@api/services/encryption.service', () => ({
  encryption: { decrypt: (v: string) => v, encrypt: (v: string) => v },
}));

import { seedCoaForStore } from '@api/services/accounting/account.service';
import { postOrderPaymentJournal as postOrderPaymentJournalRaw } from '@api/services/accounting/posting/order-posting';
import { postRefundJournal as postRefundJournalRaw } from '@api/services/accounting/posting/refund-posting';
import {
  postAmountOnlyRefundJournal,
  postPartialReturnJournal,
} from '@api/services/accounting/posting/partial-return-posting';
import { PaymentService } from '@api/services/payment-providers/payment.factory';
import { V2ProviderBridge } from '@api/services/payment-providers/v2-bridge';
import { ReturnService } from '@api/services/return.service';
import { OrderService } from '@api/services/order.service';
import { WalletService } from '@api/services/wallet.service';
import { VariantService } from '@api/services/variant.service';
import { InventoryService } from '@api/services/inventory.service';
import { AnalyticsService } from '@api/services/analytics.service';
import { deadStockValueFils } from '@api/services/accounting/deadstock-scan.service';
import { storeStockValueFils } from '@api/lib/effective-inventory-sql';
import { handleOrderRefunded } from '@api/lib/inngest/functions/order-refunded';
import { inngest } from '@api/lib/inngest/client';

const hasDb =
  !!process.env.DATABASE_URL && !process.env.DATABASE_URL.includes('localhost:5432/test_db');

const stepStub = { run: async <T>(_id: string, fn: () => Promise<T>): Promise<T> => fn() };
const TAG = `omd-${Date.now().toString(36)}-${process.pid}`;
let seq = 0;
const uid = (label: string) => `${TAG}-${label}-${++seq}-${Math.random().toString(36).slice(2, 7)}`;

describe.skipIf(!hasDb)('owner money decisions 2026-10-01', () => {
  let ownerId: string;
  let storeId: string;
  // Production runs these inside runInTenantContext(storeId); the tenant guard
  // needs the same ambient store here.
  const postOrderPaymentJournal = (a: Parameters<typeof postOrderPaymentJournalRaw>[0]) =>
    runInTenantContext(storeId, () => postOrderPaymentJournalRaw(a));
  const postRefundJournal = (a: Parameters<typeof postRefundJournalRaw>[0]) =>
    runInTenantContext(storeId, () => postRefundJournalRaw(a));
  let productA: string; // 1333 piastres, cost 611
  let productB: string; // 777 piastres, cost 409
  const code = new Map<string, string>(); // account code -> id

  beforeAll(async () => {
    const owner = await prisma.user.create({
      data: {
        email: `${uid('owner')}@example.test`,
        passwordHash: 'x',
        firstName: 'Owner',
        lastName: 'Decisions',
        role: 'store_admin',
      },
    });
    ownerId = owner.id;
    const slug = uid('store');
    const store = await prisma.store.create({
      data: { name: slug, slug, ownerId, currency: 'EGP', template: 'qamar' },
    });
    storeId = store.id;
    await seedCoaForStore(storeId);
    for (const a of await prisma.account.findMany({ where: { storeId } })) code.set(a.code, a.id);
    await prisma.paymentConfig.create({
      data: {
        storeId,
        provider: 'kashier',
        isEnabled: true,
        isDefault: true,
        apiKey: 'sk_test_omd',
        testMode: true,
      },
    });
    const mk = (name: string, price: number, costPrice: number) =>
      prisma.product.create({
        data: {
          storeId,
          name,
          slug: uid(name),
          price,
          costPrice,
          inventory: 50,
          status: 'active',
        },
      });
    productA = (await mk('omd-a', 1333, 611)).id;
    productB = (await mk('omd-b', 777, 409)).id;
  });

  afterAll(async () => {
    await withRlsBypass(async tx => {
      await tx.journalLine.deleteMany({ where: { entry: { storeId } } }).catch(() => {});
      await tx.journalEntry.deleteMany({ where: { storeId } }).catch(() => {});
      await tx.walletTransaction.deleteMany({ where: { storeId } }).catch(() => {});
      await tx.customerWallet.deleteMany({ where: { storeId } }).catch(() => {});
      await tx.paymentEvent.deleteMany({ where: { storeId } }).catch(() => {});
      await tx.returnItem.deleteMany({ where: { return: { storeId } } }).catch(() => {});
      await tx.return.deleteMany({ where: { storeId } }).catch(() => {});
      await tx.orderEvent.deleteMany({ where: { storeId } }).catch(() => {});
      await tx.inventoryHistory.deleteMany({ where: { storeId } }).catch(() => {});
      await tx.payment.deleteMany({ where: { order: { storeId } } }).catch(() => {});
      await tx.orderItem.deleteMany({ where: { order: { storeId } } }).catch(() => {});
      await tx.order.deleteMany({ where: { storeId } }).catch(() => {});
      await tx.deadStockFlag.deleteMany({ where: { storeId } }).catch(() => {});
      await tx.productVariant.deleteMany({ where: { product: { storeId } } }).catch(() => {});
      await tx.product.deleteMany({ where: { storeId } }).catch(() => {});
      await tx.paymentConfig.deleteMany({ where: { storeId } }).catch(() => {});
      await tx.account.deleteMany({ where: { storeId } }).catch(() => {});
      await tx.user.deleteMany({ where: { email: { contains: TAG } } }).catch(() => {});
      await tx.store.deleteMany({ where: { id: storeId } }).catch(() => {});
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const inRequest = <T>(fn: () => Promise<T>) => runInTenantContext(storeId, fn);

  async function newCustomer(): Promise<string> {
    const u = await prisma.user.create({
      data: {
        email: `${uid('cust')}@example.test`,
        passwordHash: 'x',
        firstName: 'C',
        lastName: 'D',
        role: 'customer',
        storeId,
      },
    });
    return u.id;
  }

  /**
   * A delivered, paid Tap order: A 1333 × 3 + B 777 × 2 = 5553 subtotal.
   * Defaults: discount 101, tax 277 (exclusive), shipping 250 → total 5979.
   */
  async function paidOrder(opts: {
    customerId: string;
    discount?: number;
    tax?: number;
    shipping?: number;
    walletAmount?: number;
  }) {
    const discount = opts.discount ?? 101;
    const tax = opts.tax ?? 277;
    const shipping = opts.shipping ?? 250;
    const walletAmount = opts.walletAmount ?? 0;
    const total = 5553 - discount + tax + shipping;
    const n = uid('ord');
    const order = await prisma.order.create({
      data: {
        storeId,
        customerId: opts.customerId,
        orderNumber: `OMD-${n}`,
        status: 'delivered',
        paymentStatus: 'paid',
        subtotal: 5553,
        discount,
        tax,
        shipping,
        total,
        walletAmount,
        currency: 'EGP',
        shippingAddress: {},
        billingAddress: {},
        items: {
          create: [
            {
              productId: productA,
              productName: 'omd-a',
              quantity: 3,
              price: 1333,
              total: 3999,
              costPrice: 611,
            },
            {
              productId: productB,
              productName: 'omd-b',
              quantity: 2,
              price: 777,
              total: 1554,
              costPrice: 409,
            },
          ],
        },
        payments: {
          create: [
            {
              provider: 'kashier',
              status: 'completed',
              amount: total - walletAmount,
              transactionId: `chg_${n}`,
              paidAt: new Date(),
            },
          ],
        },
      },
      include: { items: true, payments: true },
    });
    const itemA = order.items.find(i => i.productId === productA)!;
    const itemB = order.items.find(i => i.productId === productB)!;
    return { order, itemA, itemB, transactionId: order.payments[0].transactionId! };
  }

  async function receivedReturn(
    order: { id: string; customerId: string | null },
    items: Array<{ orderItemId: string; productId: string; quantity: number }>,
    extra: { status?: 'received' | 'completed'; refundMethod?: string; refundAmount?: number } = {}
  ) {
    return prisma.return.create({
      data: {
        storeId,
        orderId: order.id,
        customerId: order.customerId!,
        returnNumber: uid('RET'),
        type: 'return',
        status: extra.status ?? 'received',
        reason: 'defective',
        refundAmount: extra.refundAmount ?? 0,
        refundMethod: extra.refundMethod ?? null,
        refundedAt: extra.status === 'completed' ? new Date() : null,
        items: {
          create: items.map(i => ({
            orderItemId: i.orderItemId,
            productId: i.productId,
            productName: 'omd',
            quantity: i.quantity,
          })),
        },
      },
    });
  }

  /** Every line of one journal entry, as `code DR/CR amount`, sorted. */
  async function linesOf(sourceId: string): Promise<string[]> {
    const entry = await prisma.journalEntry.findFirst({
      where: { storeId, source: 'order', sourceId },
      include: { lines: { include: { account: { select: { code: true } } } } },
    });
    if (!entry) return [];
    return entry.lines
      .map(l => `${l.account.code} ${l.debit > 0 ? 'DR' : 'CR'} ${l.debit || l.credit}`)
      .sort();
  }

  function providerPays(refundId: string) {
    return vi.spyOn(V2ProviderBridge.prototype, 'refund').mockImplementation(async req => ({
      success: true,
      provider: 'kashier',
      refundId,
      transactionId: req.transactionId,
      amount: req.amount ?? 0,
      status: 'pending',
    }));
  }

  // ─── 1. #2078 — disabled variant excluded from stock value, no GL ─────────
  describe('disabled variant with stock (#2078)', () => {
    it('is excluded by every stock-value reader and posts no journal entry', async () => {
      const product = await prisma.product.create({
        data: {
          storeId,
          name: 'omd-variant-product',
          slug: uid('vp'),
          price: 2000,
          costPrice: 997,
          inventory: 0,
          hasVariants: true,
          status: 'active',
          variants: {
            create: [
              { title: 'Kept', costPrice: 733, inventory: 7 },
              { title: 'To disable', costPrice: 419, inventory: 13 },
            ],
          },
        },
        include: { variants: true },
      });
      const toDisable = product.variants.find(v => v.title === 'To disable')!;
      // omd-a + omd-b: 50 units each at cost 611 / 409.
      const simpleValue = 50 * 611 + 50 * 409;
      const before = await storeStockValueFils(storeId);
      expect(before).toBe(simpleValue + 7 * 733 + 13 * 419);

      const entriesBefore = await prisma.journalEntry.count({ where: { storeId } });
      await VariantService.updateVariant(storeId, product.id, toDisable.id, { isActive: false });
      const entriesAfter = await prisma.journalEntry.count({ where: { storeId } });
      // Owner decision: disabling posts NOTHING to the ledger.
      expect(entriesAfter).toBe(entriesBefore);

      const expected = simpleValue + 7 * 733; // 13 × 419 on the disabled variant is gone
      // Finance dashboard (and the analytics snapshot — the same query).
      expect(await storeStockValueFils(storeId)).toBe(expected);
      expect((await AnalyticsService.stockSnapshot(storeId)).stockValue).toBe(expected);
      // Inventory page: stats and the product's own row.
      expect((await InventoryService.getStats(storeId)).totalValue).toBe(expected);
      const list = await InventoryService.listProducts(storeId, {});
      expect(list.products.find(p => p.id === product.id)?.stockValue).toBe(7 * 733);
      // Dead stock.
      const reread = await prisma.product.findUniqueOrThrow({
        where: { id: product.id },
        select: {
          inventory: true,
          costPrice: true,
          variants: { select: { inventory: true, isActive: true, costPrice: true } },
        },
      });
      expect(deadStockValueFils(reread)).toBe(7 * 733);

      await prisma.productVariant.deleteMany({ where: { productId: product.id } });
      await prisma.product.delete({ where: { id: product.id } });
    });
  });

  // ─── 2. #1207 / #1351 — credit account follows the refund method ──────────
  describe('partial-return credit follows the refund method (#1207, #1351)', () => {
    // Returning 1 × A of the default order: gross 1333, discount share
    // floor(101·1333/5553) = 24, tax share floor(277·1333/5553) = 66
    // → revenue 1309, cash 1375.
    it('card/gateway: CR the sale cash/gateway clearing account for what the provider was sent', async () => {
      const customerId = await newCustomer();
      const { order, itemA, transactionId } = await paidOrder({ customerId });
      await postOrderPaymentJournal({ orderId: order.id });
      const ret = await receivedReturn(order, [
        { orderItemId: itemA.id, productId: productA, quantity: 1 },
      ]);
      const provider = providerPays(uid('rf'));
      vi.spyOn(OrderService, 'applyRefundEffects').mockResolvedValue(undefined);
      await inRequest(() => ReturnService.complete(storeId, ret.id, ownerId, 'original'));
      expect(provider.mock.calls[0][0]).toMatchObject({ transactionId, amount: 1375 });

      await postPartialReturnJournal({
        orderId: order.id,
        storeId,
        refundKey: ret.id,
        items: [{ orderItemId: itemA.id, quantity: 1 }],
      });
      expect(await linesOf(`${order.id}:partial:${ret.id}`)).toEqual(
        ['1010 CR 1375', '2100 DR 66', '4000 DR 1309'].sort()
      );
      expect(await linesOf(`${order.id}:partial:${ret.id}:cogs`)).toEqual(
        ['1200 DR 611', '5000 CR 611'].sort()
      );
    });

    it('off-platform store credit (wallet off): CR 2160 Store Credit Liability', async () => {
      const customerId = await newCustomer();
      const { order, itemA } = await paidOrder({ customerId });
      await postOrderPaymentJournal({ orderId: order.id });
      const ret = await receivedReturn(order, [
        { orderItemId: itemA.id, productId: productA, quantity: 1 },
      ]);
      vi.spyOn(OrderService, 'applyRefundEffects').mockResolvedValue(undefined);
      await inRequest(() => ReturnService.complete(storeId, ret.id, ownerId, 'store_credit'));

      await postPartialReturnJournal({
        orderId: order.id,
        storeId,
        refundKey: ret.id,
        items: [{ orderItemId: itemA.id, quantity: 1 }],
      });
      expect(await linesOf(`${order.id}:partial:${ret.id}`)).toEqual(
        ['2100 DR 66', '2160 CR 1375', '4000 DR 1309'].sort()
      );
    });

    it('store credit into the customer wallet: CR 2150 for the wallet ledger amount', async () => {
      const customerId = await newCustomer();
      const { order, itemA } = await paidOrder({ customerId });
      await postOrderPaymentJournal({ orderId: order.id });
      const ret = await receivedReturn(
        order,
        [{ orderItemId: itemA.id, productId: productA, quantity: 1 }],
        { status: 'completed', refundMethod: 'store_credit', refundAmount: 1375 }
      );
      // What ReturnService.complete commits with `customer_wallet` on.
      await WalletService.creditForReturn({
        storeId,
        customerId,
        returnId: ret.id,
        orderId: order.id,
        amount: 1375,
      });

      await postPartialReturnJournal({
        orderId: order.id,
        storeId,
        refundKey: ret.id,
        items: [{ orderItemId: itemA.id, quantity: 1 }],
      });
      expect(await linesOf(`${order.id}:partial:${ret.id}`)).toEqual(
        ['2100 DR 66', '2150 CR 1375', '4000 DR 1309'].sort()
      );
    });

    it('credits the amount ACTUALLY refunded; the difference moves sales returns, never tax', async () => {
      const customerId = await newCustomer();
      const { order, itemA } = await paidOrder({ customerId });
      await postOrderPaymentJournal({ orderId: order.id });
      const ret = await receivedReturn(
        order,
        [{ orderItemId: itemA.id, productId: productA, quantity: 1 }],
        { status: 'completed', refundMethod: 'original', refundAmount: 1374 }
      );
      await postPartialReturnJournal({
        orderId: order.id,
        storeId,
        refundKey: ret.id,
        items: [{ orderItemId: itemA.id, quantity: 1 }],
      });
      expect(await linesOf(`${order.id}:partial:${ret.id}`)).toEqual(
        ['1010 CR 1374', '2100 DR 66', '4000 DR 1308'].sort()
      );
    });

    it('a method the decision does not cover (bank_transfer) keeps the pro-rata cash credit', async () => {
      const customerId = await newCustomer();
      const { order, itemA } = await paidOrder({ customerId });
      await postOrderPaymentJournal({ orderId: order.id });
      const ret = await receivedReturn(
        order,
        [{ orderItemId: itemA.id, productId: productA, quantity: 1 }],
        { status: 'completed', refundMethod: 'bank_transfer', refundAmount: 1000 }
      );
      await postPartialReturnJournal({
        orderId: order.id,
        storeId,
        refundKey: ret.id,
        items: [{ orderItemId: itemA.id, quantity: 1 }],
      });
      expect(await linesOf(`${order.id}:partial:${ret.id}`)).toEqual(
        ['1010 CR 1375', '2100 DR 66', '4000 DR 1309'].sort()
      );
    });
  });

  // ─── 3. #1209 / #1455 — partial refund outside a return ───────────────────
  describe('partial refund outside a return (#1209, #1455)', () => {
    it('is booked as a revenue refund for that amount, once, with no stock movement', async () => {
      const customerId = await newCustomer();
      const { order, transactionId } = await paidOrder({ customerId });
      await postOrderPaymentJournal({ orderId: order.id });
      const refundId = uid('rf-dash');
      providerPays(refundId);
      const sent = vi.spyOn(inngest, 'send').mockResolvedValue({ ids: [] } as never);

      // The order page's refund-via-provider with an amount — no return.
      await inRequest(() => PaymentService.refund({ transactionId, amount: 1234 }));

      const refunded = sent.mock.calls
        .map(c => c[0] as { name: string; data: Record<string, unknown> })
        .filter(e => e.name === 'order/refunded');
      expect(refunded).toHaveLength(1);
      expect(refunded[0].data).toMatchObject({
        orderId: order.id,
        storeId,
        restoreInventory: false,
        notify: false,
        reverseWallet: false,
        partial: {
          items: [],
          refundKey: `refund:${refundId}`,
          refundAmount: 1234,
          amountOnly: true,
        },
      });

      // The two consumers of that event.
      const partial = refunded[0].data.partial as {
        items: [];
        refundKey: string;
        refundAmount: number;
        amountOnly: true;
      };
      const stockBefore = await prisma.product.findMany({
        where: { id: { in: [productA, productB] } },
        select: { id: true, inventory: true },
      });
      await handleOrderRefunded(order.id, storeId, false, false, stepStub, partial, false);
      const stockAfter = await prisma.product.findMany({
        where: { id: { in: [productA, productB] } },
        select: { id: true, inventory: true },
      });
      expect(stockAfter).toEqual(stockBefore);
      expect(await prisma.inventoryHistory.count({ where: { storeId, reference: order.id } })).toBe(
        0
      );
      expect(
        (await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).refundReversedAt
      ).toBeNull();

      const first = await postAmountOnlyRefundJournal({
        orderId: order.id,
        storeId,
        refundKey: partial.refundKey,
        amount: partial.refundAmount,
      });
      expect(first).toEqual({ posted: 1 });
      expect(await linesOf(`${order.id}:partial:refund:${refundId}`)).toEqual(
        ['1010 CR 1234', '4090 DR 1234'].sort()
      );
      // Idempotent per provider refund id: a redelivered webhook or a refresh.
      const again = await postAmountOnlyRefundJournal({
        orderId: order.id,
        storeId,
        refundKey: partial.refundKey,
        amount: partial.refundAmount,
      });
      expect(again.skipped).toBe('already-posted');
      expect(
        await prisma.journalEntry.count({
          where: { storeId, sourceId: `${order.id}:partial:refund:${refundId}` },
        })
      ).toBe(1);

      // A later FULL refund backs it out with the sale: the order nets to zero.
      await postRefundJournal({ orderId: order.id, storeId });
      const lines = await prisma.journalLine.findMany({
        where: { entry: { storeId, sourceId: { startsWith: order.id } } },
        select: { accountId: true, debit: true, credit: true },
      });
      const net = new Map<string, number>();
      for (const l of lines) net.set(l.accountId, (net.get(l.accountId) ?? 0) + l.debit - l.credit);
      expect([...net.values()].every(v => v === 0)).toBe(true);
    });
  });

  // ─── 4. #1956 — wallet + card order, partial gateway refund ───────────────
  describe('partial gateway refund on a wallet + card order (#1956)', () => {
    // No discount/tax/shipping: total 5553 = 2000 wallet + 3553 card.
    it('splits each refund pro-rata to the payment mix; the rounding piastres go to the card', async () => {
      const customerId = await newCustomer();
      await WalletService.applyEntry({
        storeId,
        customerId,
        amount: 2000,
        type: 'admin_adjust',
        idempotencyKey: uid('fund'),
        note: 'seed',
      });
      const { order, itemA, itemB, transactionId } = await paidOrder({
        customerId,
        discount: 0,
        tax: 0,
        shipping: 0,
        walletAmount: 2000,
      });
      await WalletService.applyEntry({
        storeId,
        customerId,
        amount: -2000,
        type: 'order_payment',
        idempotencyKey: `order-payment:${order.id}`,
        orderId: order.id,
      });
      await postOrderPaymentJournal({ orderId: order.id }); // WALLET-GL-1: DR cash 3553 + DR 2150 2000
      vi.spyOn(OrderService, 'applyRefundEffects').mockResolvedValue(undefined);
      const provider = providerPays(uid('rf-mix'));

      // Return 1: 1 × A = 1333. Wallet floor(1333·2000/5553) = 480, card 853.
      const r1 = await receivedReturn(order, [
        { orderItemId: itemA.id, productId: productA, quantity: 1 },
      ]);
      const preview = await inRequest(() => ReturnService.refundPreview(storeId, r1.id));
      expect(preview.gateway).toMatchObject({ available: true, amount: 853, walletShare: 480 });
      await inRequest(() => ReturnService.complete(storeId, r1.id, ownerId, 'original'));
      expect(provider.mock.calls[0][0]).toMatchObject({ transactionId, amount: 853 });
      expect(await WalletService.getBalance(storeId, customerId)).toBe(480);
      expect((await prisma.return.findUniqueOrThrow({ where: { id: r1.id } })).refundAmount).toBe(
        1333
      );

      // Return 2: everything left, 2 × A + 2 × B = 4220. Cumulatively the
      // wallet is owed all 2000, so 1520 now; the card gets 2700, which makes
      // exactly the 3553 it paid (853 + 2700) — no piastres stranded or overpaid.
      const r2 = await receivedReturn(order, [
        { orderItemId: itemA.id, productId: productA, quantity: 2 },
        { orderItemId: itemB.id, productId: productB, quantity: 2 },
      ]);
      await inRequest(() => ReturnService.complete(storeId, r2.id, ownerId, 'original'));
      expect(provider.mock.calls[1][0]).toMatchObject({ transactionId, amount: 2700 });
      expect(await WalletService.getBalance(storeId, customerId)).toBe(2000);
      const payment = await prisma.payment.findFirstOrThrow({ where: { orderId: order.id } });
      expect(payment).toMatchObject({ refundedAmount: 3553, status: 'refunded' });

      // The whole-order fanout that exhausting the payment triggers must not
      // put the 2000 back a second time.
      expect(await WalletService.reverseOrderPayment({ storeId, orderId: order.id })).toBeNull();
      expect(await WalletService.getBalance(storeId, customerId)).toBe(2000);

      // Ruling WALLET-GL-1: the wallet part of the sale is a DR on 2150, the rest is cash.
      const sale = await prisma.journalLine.findMany({
        where: { entry: { storeId, source: 'order', sourceId: order.id } },
        select: { debit: true, account: { select: { code: true } } },
      });
      const debitOn = (code: string) =>
        sale.filter(l => l.account.code === code).reduce((n, l) => n + l.debit, 0);
      expect(debitOn('2150')).toBe(2000);
      expect(
        sale.filter(l => l.account.code.startsWith('10')).reduce((n, l) => n + l.debit, 0)
      ).toBe(3553);
    });

    it('a whole-order reversal after a split partial returns only the rest of the wallet spend', async () => {
      const customerId = await newCustomer();
      await WalletService.applyEntry({
        storeId,
        customerId,
        amount: 2000,
        type: 'admin_adjust',
        idempotencyKey: uid('fund'),
        note: 'seed',
      });
      const { order, itemA } = await paidOrder({
        customerId,
        discount: 0,
        tax: 0,
        shipping: 0,
        walletAmount: 2000,
      });
      await WalletService.applyEntry({
        storeId,
        customerId,
        amount: -2000,
        type: 'order_payment',
        idempotencyKey: `order-payment:${order.id}`,
        orderId: order.id,
      });
      vi.spyOn(OrderService, 'applyRefundEffects').mockResolvedValue(undefined);
      providerPays(uid('rf-mix2'));
      const r1 = await receivedReturn(order, [
        { orderItemId: itemA.id, productId: productA, quantity: 1 },
      ]);
      await inRequest(() => ReturnService.complete(storeId, r1.id, ownerId, 'original'));
      expect(await WalletService.getBalance(storeId, customerId)).toBe(480);

      // The merchant then cancels/refunds the rest of the order.
      const reversal = await WalletService.reverseOrderPayment({ storeId, orderId: order.id });
      expect(reversal?.entry.amount).toBe(1520);
      expect(await WalletService.getBalance(storeId, customerId)).toBe(2000);
    });
  });
});
