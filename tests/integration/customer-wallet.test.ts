/**
 * Customer wallet (store credit, D1) — integration against a REAL Postgres.
 *
 * Proves what the unit tests cannot:
 *   1. `SELECT … FOR UPDATE` really serialises two concurrent debits — exactly
 *      one wins, the balance never goes negative.
 *   2. Two concurrent deliveries of the SAME idempotency key move money once.
 *   3. The DB CHECK refuses a negative balance even when the service is
 *      bypassed.
 *   4. Return completed with `store_credit` → credited once, with the same
 *      allocation the gateway path uses (partial and full).
 *   5. Checkout debit (partial + paid-in-full), atomic with the order; the
 *      order/refunded fanout and the payment-create rollback each put the
 *      wallet portion back exactly once.
 *   6. Feature-off / accounting-on checkout ignores `useWallet` entirely.
 *   7. Erasure forfeits the balance, scrubs notes and keeps the ledger;
 *      export carries the wallet.
 *   8. A store delete still cascades cleanly (NO ACTION customer FKs).
 *
 * Retry-safe (vitest `retry: 1`): every test makes its own customer and cart
 * session, so a retried attempt never inherits the failed attempt's balance.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { prisma, withMoneyTx } from '@ebda/database';
import { WalletService } from '@api/services/wallet.service';
import { OrderService } from '@api/services/order.service';
import { ReturnService } from '@api/services/return.service';
import { CartService } from '@api/services/cart.service';
import { AuthService } from '@api/services/auth.service';
import { StoreService } from '@api/services/store.service';
import { handleOrderRefunded } from '@api/lib/inngest/functions/order-refunded';
import { cartSessionId, hasDb } from '../helpers/bundle-fixtures';

const stepStub = { run: async <T>(_id: string, fn: () => Promise<T>): Promise<T> => fn() };
const TAG = `wallet-${Date.now().toString(36)}-${process.pid}`;
let seq = 0;
const uid = (label: string) => `${TAG}-${label}-${++seq}`;

const baseOrderData = {
  shippingAddress: {
    firstName: 'Wallet',
    lastName: 'Buyer',
    address1: 'Block 1',
    city: 'Cairo',
    state: 'Capital',
    postalCode: '00000',
    country: 'EG',
    phone: '96550000000',
  },
  paymentMethod: 'paymob',
};

describe.skipIf(!hasDb)('customer wallet — integration', () => {
  let ownerId: string;
  let storeId: string;
  let productA: string; // 6000 piastres
  let productB: string; // 4000 piastres

  async function setFeature(featureKey: string, enabled: boolean) {
    await prisma.storeFeature.upsert({
      where: { storeId_featureKey: { storeId, featureKey } },
      create: { storeId, featureKey, enabled, enabledBy: ownerId },
      update: { enabled },
    });
  }

  // One phone per customer: the open-hold cap (#65/#75) counts the fixed baseOrderData phone
  // across every test in this file. Per CUSTOMER, not per order, so the "full-wallet COD is
  // exempt at the hold cap" case still stacks its two COD holds on one identity.
  const customerPhones = new Map<string, string>();
  function phoneFor(customerId: string): string {
    let phone = customerPhones.get(customerId);
    if (!phone) {
      phone = `9655${String(customerPhones.size + 1).padStart(7, '0')}`;
      customerPhones.set(customerId, phone);
    }
    return phone;
  }

  async function newCustomer(): Promise<string> {
    const u = await prisma.user.create({
      data: {
        email: `${uid('cust')}@example.test`,
        passwordHash: 'x'.repeat(60),
        firstName: 'Wallet',
        lastName: 'Customer',
        role: 'customer',
        status: 'active',
        emailVerified: true,
        storeId,
      },
    });
    return u.id;
  }

  async function fund(customerId: string, amount: number) {
    await WalletService.applyEntry({
      storeId,
      customerId,
      amount,
      type: 'admin_adjust',
      idempotencyKey: uid('fund'),
      note: 'seed',
    });
  }

  async function balanceOf(customerId: string) {
    return WalletService.getBalance(storeId, customerId);
  }

  async function ledgerSum(customerId: string) {
    const agg = await prisma.walletTransaction.aggregate({
      where: { storeId, customerId },
      _sum: { amount: true },
    });
    return agg._sum.amount ?? 0;
  }

  async function checkout(
    customerId: string,
    items: Array<[string, number]>,
    useWallet: boolean,
    paymentMethod = 'paymob'
  ) {
    const sessionId = cartSessionId('wallet');
    const cart = await CartService.getOrCreate(storeId, sessionId, customerId);
    for (const [productId, quantity] of items) {
      await prisma.cartItem.create({ data: { cartId: cart.id, productId, quantity } });
    }
    const order = await OrderService.create(storeId, customerId, sessionId, {
      ...baseOrderData,
      shippingAddress: { ...baseOrderData.shippingAddress, phone: phoneFor(customerId) },
      paymentMethod,
      useWallet,
    });
    return { order, sessionId };
  }

  it('full-wallet COD is exempt at the hold cap; partial-wallet COD is refused without a debit', async () => {
    const customer = await newCustomer();
    await fund(customer, 20000);
    await checkout(customer, [[productA, 1]], false, 'cod');
    await checkout(customer, [[productA, 1]], false, 'cod');
    const full = await checkout(customer, [[productA, 1]], true, 'cod');
    expect(full.order.paymentStatus).toBe('paid');
    expect(full.order.manualHoldAdmitted).toBe(false);
    const remaining = await balanceOf(customer);
    await WalletService.applyEntry({
      storeId,
      customerId: customer,
      amount: -(remaining - 1000),
      type: 'admin_adjust',
      idempotencyKey: uid('reduce'),
      note: 'partial wallet fixture',
    });
    const before = await balanceOf(customer);
    const stock = (await prisma.product.findUniqueOrThrow({ where: { id: productA } })).inventory;
    await expect(checkout(customer, [[productA, 1]], true, 'cod')).rejects.toMatchObject({
      code: 'TOO_MANY_OPEN_HOLDS',
    });
    expect(await balanceOf(customer)).toBe(before);
    expect((await prisma.product.findUniqueOrThrow({ where: { id: productA } })).inventory).toBe(
      stock
    );
  });

  beforeAll(async () => {
    const owner = await prisma.user.create({
      data: {
        email: `${TAG}-owner@example.test`,
        passwordHash: 'x'.repeat(60),
        firstName: 'Owner',
        lastName: 'Wallet',
        role: 'store_admin',
        status: 'active',
        emailVerified: true,
      },
    });
    ownerId = owner.id;
    const store = await prisma.store.create({
      data: {
        name: 'Wallet Store',
        slug: `${TAG}-store`,
        ownerId,
        status: 'active',
        // The fixture store keeps accounting OFF; accounting-on wallet checkout is covered below
        // and in tests/integration/accounting/wallet-gl.test.ts (Ruling WALLET-GL-1).
        accountingEnabled: false,
      },
    });
    storeId = store.id;
    await setFeature('customer_wallet', true);
    await setFeature('customer_wallet_checkout', true);
    const [a, b] = await Promise.all(
      [
        ['A', 6000],
        ['B', 4000],
      ].map(([n, price]) =>
        prisma.product.create({
          data: {
            storeId,
            name: `Wallet Product ${n}`,
            slug: `${TAG}-p-${n}`,
            price: price as number,
            inventory: 1000,
            trackInventory: false,
            status: 'active',
          },
        })
      )
    );
    productA = a.id;
    productB = b.id;
  });

  afterAll(async () => {
    if (!storeId) return;
    await prisma.walletTransaction.deleteMany({ where: { storeId } });
    await prisma.customerWallet.deleteMany({ where: { storeId } });
    await prisma.returnItem.deleteMany({ where: { return: { storeId } } });
    await prisma.return.deleteMany({ where: { storeId } });
    await prisma.orderEvent.deleteMany({ where: { storeId } });
    await prisma.inventoryHistory.deleteMany({ where: { storeId } });
    await prisma.orderItem.deleteMany({ where: { order: { storeId } } });
    await prisma.payment.deleteMany({ where: { order: { storeId } } });
    await prisma.order.deleteMany({ where: { storeId } });
    await prisma.cartItem.deleteMany({ where: { cart: { storeId } } });
    await prisma.cart.deleteMany({ where: { storeId } });
    await prisma.product.deleteMany({ where: { storeId } });
    await prisma.storeFeature.deleteMany({ where: { storeId } });
    await prisma.user.deleteMany({ where: { storeId, role: 'customer' } });
    await prisma.store.deleteMany({ where: { id: storeId } });
    await prisma.user.deleteMany({ where: { id: ownerId } });
    await prisma.$disconnect();
  });

  // ─── 1-3. Ledger guards ────────────────────────────────────────────────

  it('two concurrent debits against one balance: exactly one wins, never negative', async () => {
    const c = await newCustomer();
    await fund(c, 100);
    const debit = (label: string) =>
      WalletService.applyEntry({
        storeId,
        customerId: c,
        amount: -70,
        type: 'admin_adjust',
        idempotencyKey: uid(label),
        note: 'race',
      });
    const results = await Promise.allSettled([debit('d1'), debit('d2'), debit('d3')]);
    const won = results.filter(r => r.status === 'fulfilled');
    const lost = results.filter(r => r.status === 'rejected') as PromiseRejectedResult[];
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(2);
    for (const l of lost) expect(l.reason.code).toBe('INSUFFICIENT_WALLET_BALANCE');
    expect(await balanceOf(c)).toBe(30);
    expect(await ledgerSum(c)).toBe(30);
  });

  it('concurrent deliveries of the SAME idempotency key credit once', async () => {
    const c = await newCustomer();
    await fund(c, 10);
    const key = uid('same-key');
    const credit = () =>
      WalletService.applyEntry({
        storeId,
        customerId: c,
        amount: 50,
        type: 'refund_credit',
        idempotencyKey: key,
      });
    const results = await Promise.all([credit(), credit(), credit()]);
    expect(results.filter(r => !r.replayed)).toHaveLength(1);
    expect(await balanceOf(c)).toBe(60);
    expect(await prisma.walletTransaction.count({ where: { storeId, idempotencyKey: key } })).toBe(
      1
    );
  });

  it('the database refuses a negative balance even when the service is bypassed', async () => {
    const c = await newCustomer();
    await fund(c, 10);
    await expect(
      prisma.$executeRaw`UPDATE public.customer_wallets SET balance = -1 WHERE store_id = ${storeId} AND customer_id = ${c}`
    ).rejects.toThrow(/customer_wallets_balance_non_negative/);
    expect(await balanceOf(c)).toBe(10);
  });

  // ─── 4. Return → store credit ─────────────────────────────────────────

  async function deliveredOrderWithReturn(
    customerId: string,
    returnLines: 'first' | 'all',
    useWallet = false
  ) {
    const { order } = await checkout(
      customerId,
      [
        [productA, 1],
        [productB, 1],
      ],
      useWallet
    );
    await prisma.order.update({
      where: { id: order.id },
      data: { status: 'delivered', paymentStatus: 'paid' },
    });
    const lines = returnLines === 'first' ? order.items.slice(0, 1) : order.items;
    const ret = await prisma.return.create({
      data: {
        storeId,
        orderId: order.id,
        customerId,
        returnNumber: uid('RET'),
        type: 'return',
        status: 'received',
        reason: 'test',
        refundAmount: lines.reduce((s, l) => s + l.total, 0),
        items: {
          create: lines.map(l => ({
            orderItemId: l.id,
            productId: l.productId,
            productName: l.productName,
            quantity: l.quantity,
          })),
        },
      },
    });
    return { order, ret, lines };
  }

  it('a partial return completed with store_credit credits the allocated amount, once', async () => {
    const effects = vi.spyOn(OrderService, 'applyRefundEffects').mockResolvedValue(undefined);
    try {
      const c = await newCustomer();
      const { ret, lines } = await deliveredOrderWithReturn(c, 'first');
      await ReturnService.complete(storeId, ret.id, ownerId, 'store_credit');

      // No discount/tax on this store → the allocation is the line value.
      const expected = lines[0].total;
      expect(await balanceOf(c)).toBe(expected);
      const row = await prisma.walletTransaction.findFirst({
        where: { storeId, returnId: ret.id },
      });
      expect(row).toMatchObject({ type: 'refund_credit', amount: expected });
      const after = await prisma.return.findUnique({ where: { id: ret.id } });
      expect(after).toMatchObject({ status: 'completed', refundAmount: expected });

      // A second completion attempt is refused and moves no money.
      await expect(
        ReturnService.complete(storeId, ret.id, ownerId, 'store_credit')
      ).rejects.toMatchObject({ statusCode: 400 });
      expect(await balanceOf(c)).toBe(expected);
    } finally {
      effects.mockRestore();
    }
  });

  it('a full return on a part-wallet-paid order credits the rest; the fanout returns the wallet part', async () => {
    const effects = vi.spyOn(OrderService, 'applyRefundEffects').mockResolvedValue(undefined);
    try {
      const c = await newCustomer();
      await fund(c, 2500);
      const { order, ret } = await deliveredOrderWithReturn(c, 'all', true);
      expect(order.walletAmount).toBe(2500);
      expect(await balanceOf(c)).toBe(0);

      await ReturnService.complete(storeId, ret.id, ownerId, 'store_credit');
      // Return credits total − walletAmount (10000 − 2500) …
      expect(await balanceOf(c)).toBe(7500);
      // … and the whole-order fanout puts the 2500 wallet spend back.
      await handleOrderRefunded(order.id, storeId, true, false, stepStub);
      await handleOrderRefunded(order.id, storeId, true, false, stepStub); // redelivery
      expect(await balanceOf(c)).toBe(10_000);
      expect(await ledgerSum(c)).toBe(10_000);
    } finally {
      effects.mockRestore();
    }
  });

  it('an exchange completed with store_credit never credits the wallet', async () => {
    const effects = vi.spyOn(OrderService, 'applyRefundEffects').mockResolvedValue(undefined);
    try {
      const c = await newCustomer();
      const { ret } = await deliveredOrderWithReturn(c, 'first');
      await prisma.return.update({ where: { id: ret.id }, data: { type: 'exchange' } });
      await ReturnService.complete(storeId, ret.id, ownerId, 'store_credit');
      expect(await balanceOf(c)).toBe(0);
    } finally {
      effects.mockRestore();
    }
  });

  // ─── 5. Checkout debit + reversals ────────────────────────────────────

  it('partial wallet payment: debited inside the order tx, amount due is the remainder', async () => {
    const c = await newCustomer();
    await fund(c, 3000);
    const { order } = await checkout(c, [[productA, 1]], true);
    expect(order.total).toBe(6000);
    expect(order.walletAmount).toBe(3000);
    expect(order.status).toBe('pending');
    expect(order.paymentStatus).toBe('unpaid');
    expect(await balanceOf(c)).toBe(0);
    const spend = await prisma.walletTransaction.findFirst({
      where: { storeId, orderId: order.id, type: 'order_payment' },
    });
    expect(spend?.amount).toBe(-3000);
  });

  it('wallet covering the whole order: created confirmed + paid, no gateway step', async () => {
    const c = await newCustomer();
    await fund(c, 20_000);
    const { order } = await checkout(c, [[productB, 1]], true);
    expect(order.walletAmount).toBe(4000);
    expect(order.status).toBe('confirmed');
    expect(order.paymentStatus).toBe('paid');
    expect(await balanceOf(c)).toBe(16_000);
  });

  it('cancel/refund puts the wallet spend back exactly once across redeliveries', async () => {
    const c = await newCustomer();
    await fund(c, 5000);
    const { order } = await checkout(c, [[productA, 1]], true);
    expect(await balanceOf(c)).toBe(0);
    await Promise.all([
      handleOrderRefunded(order.id, storeId, true, false, stepStub),
      handleOrderRefunded(order.id, storeId, true, false, stepStub),
    ]);
    await handleOrderRefunded(order.id, storeId, true, false, stepStub);
    expect(await balanceOf(c)).toBe(5000);
    expect(
      await prisma.walletTransaction.count({
        where: { storeId, orderId: order.id, type: 'order_payment_reversal' },
      })
    ).toBe(1);
  });

  it('the backorder single-line cancel path (reverseWallet: false) never returns the spend', async () => {
    const c = await newCustomer();
    await fund(c, 5000);
    const { order } = await checkout(c, [[productA, 1]], true);
    await handleOrderRefunded(order.id, storeId, false, false, stepStub, undefined, false);
    expect(await balanceOf(c)).toBe(0);
  });

  it('a payment-create failure rollback puts the wallet spend back', async () => {
    const c = await newCustomer();
    await fund(c, 1000);
    const { order, sessionId } = await checkout(c, [[productA, 1]], true);
    expect(await balanceOf(c)).toBe(0);
    await OrderService.rollbackForPaymentFailure(storeId, order.id, sessionId);
    expect(await balanceOf(c)).toBe(1000);
    const after = await prisma.order.findUnique({ where: { id: order.id } });
    expect(after?.status).toBe('cancelled');
  });

  it('a concurrent spend that drained the balance rolls the whole order back', async () => {
    const c = await newCustomer();
    await fund(c, 5000);
    // Resolve the checkout amount, then drain the wallet before the order tx
    // debits it — the debit re-checks under the lock and must refuse.
    const spy = vi.spyOn(WalletService, 'getBalance').mockImplementationOnce(async () => {
      await WalletService.applyEntry({
        storeId,
        customerId: c,
        amount: -5000,
        type: 'admin_adjust',
        idempotencyKey: uid('drain'),
        note: 'drain',
      });
      return 5000;
    });
    try {
      const sessionId = cartSessionId('wallet-race');
      const cart = await CartService.getOrCreate(storeId, sessionId, c);
      await prisma.cartItem.create({ data: { cartId: cart.id, productId: productA, quantity: 1 } });
      await expect(
        OrderService.create(storeId, c, sessionId, { ...baseOrderData, useWallet: true })
      ).rejects.toMatchObject({ code: 'INSUFFICIENT_WALLET_BALANCE' });
      expect(await prisma.order.count({ where: { storeId, customerId: c } })).toBe(0);
      expect(await balanceOf(c)).toBe(0);
    } finally {
      spy.mockRestore();
    }
  });

  // ─── 6. Feature off / accounting on → checkout unchanged ──────────────

  it('checkout toggle OFF: useWallet is ignored and the balance is untouched', async () => {
    await setFeature('customer_wallet_checkout', false);
    try {
      const c = await newCustomer();
      await fund(c, 3000);
      const { order } = await checkout(c, [[productA, 1]], true);
      expect(order.walletAmount).toBe(0);
      expect(order.total).toBe(6000);
      expect(await balanceOf(c)).toBe(3000);
    } finally {
      await setFeature('customer_wallet_checkout', true);
    }
  });

  it('accounting ON: wallet checkout is available and spends the balance (Ruling WALLET-GL-1)', async () => {
    await prisma.store.update({ where: { id: storeId }, data: { accountingEnabled: true } });
    try {
      expect(await WalletService.getCheckoutAvailability(storeId)).toEqual({
        available: true,
        reason: null,
      });
      const c = await newCustomer();
      await fund(c, 3000);
      const { order } = await checkout(c, [[productA, 1]], true);
      expect(order.walletAmount).toBe(3000);
      expect(await balanceOf(c)).toBe(0);
    } finally {
      await prisma.store.update({ where: { id: storeId }, data: { accountingEnabled: false } });
    }
  });

  it('customer_wallet OFF: store_credit keeps its old off-platform meaning', async () => {
    await setFeature('customer_wallet', false);
    const effects = vi.spyOn(OrderService, 'applyRefundEffects').mockResolvedValue(undefined);
    try {
      const c = await newCustomer();
      const { ret } = await deliveredOrderWithReturn(c, 'first');
      await ReturnService.complete(storeId, ret.id, ownerId, 'store_credit');
      expect(await prisma.customerWallet.count({ where: { storeId, customerId: c } })).toBe(0);
      const after = await prisma.return.findUnique({ where: { id: ret.id } });
      expect(after?.status).toBe('completed');
    } finally {
      effects.mockRestore();
      await setFeature('customer_wallet', true);
    }
  });

  // ─── 7. Erasure / export ──────────────────────────────────────────────

  it('export carries the wallet; erasure forfeits the balance, scrubs notes, keeps the ledger', async () => {
    const c = await newCustomer();
    await WalletService.applyEntry({
      storeId,
      customerId: c,
      amount: 4200,
      type: 'admin_adjust',
      idempotencyKey: uid('pii'),
      note: 'called from +965 5555 1234 about a late order',
    });

    const bundle = await AuthService.exportAccount(c);
    expect(bundle.wallets).toEqual([expect.objectContaining({ storeId, balance: 4200 })]);
    expect(bundle.walletTransactions).toHaveLength(1);

    await AuthService.eraseAccount(c);
    expect(await balanceOf(c)).toBe(0);
    const rows = await prisma.walletTransaction.findMany({
      where: { storeId, customerId: c },
      orderBy: { createdAt: 'asc' },
    });
    expect(rows.map(r => r.type)).toEqual(['admin_adjust', 'expire']);
    expect(rows[0].note).toBeNull();
    expect(rows[1]).toMatchObject({ amount: -4200, balanceAfter: 0 });
    expect(await ledgerSum(c)).toBe(0);

    // Erasure is documented idempotent — a re-run must not fail on the key.
    // eraseAccount now returns its CRM-scrub outcome (#1880); a re-run must
    // still resolve, and must not be flagged as an ambiguous CRM match.
    const erasureAudits = () =>
      prisma.auditLog.findMany({
        where: { resourceId: c, action: 'customer.wallet.erased' },
        select: { storeId: true, details: true },
      });
    const afterFirst = await erasureAudits();
    expect(afterFirst).toEqual([
      { storeId, details: expect.objectContaining({ forfeitedFils: 4200 }) },
    ]);
    await expect(AuthService.eraseAccount(c)).resolves.toMatchObject({ crmAmbiguous: false });
    // Issues 2122 / 2125: the re-run moved no money, so it appends no audit row.
    expect(await erasureAudits()).toEqual(afterFirst);
  });

  // ─── 8. FK cascade ────────────────────────────────────────────────────

  it('deleting a store with wallets cascades (NO ACTION customer FKs do not block it)', async () => {
    const owner2 = await prisma.user.create({
      data: {
        email: `${uid('owner2')}@example.test`,
        passwordHash: 'x'.repeat(60),
        firstName: 'O',
        lastName: 'Two',
        role: 'store_admin',
        status: 'active',
        emailVerified: true,
      },
    });
    const s2 = await prisma.store.create({
      data: { name: 'Doomed', slug: uid('doomed'), ownerId: owner2.id, status: 'active' },
    });
    const cust = await prisma.user.create({
      data: {
        email: `${uid('c2')}@example.test`,
        passwordHash: 'x'.repeat(60),
        firstName: 'C',
        lastName: 'Two',
        role: 'customer',
        status: 'active',
        emailVerified: true,
        storeId: s2.id,
      },
    });
    await WalletService.applyEntry({
      storeId: s2.id,
      customerId: cust.id,
      amount: 999,
      type: 'admin_adjust',
      idempotencyKey: uid('doomed-fund'),
      note: 'x',
    });

    // Store deletion is a super_admin action: the audit-trail definers check the acting user.
    const operator = await prisma.user.create({
      data: {
        email: `${uid('operator')}@test.local`,
        passwordHash: 'x',
        firstName: 'Op',
        lastName: 'Erator',
        role: 'super_admin',
      },
    });
    await StoreService.delete(s2.id, operator.id);

    expect(await prisma.store.count({ where: { id: s2.id } })).toBe(0);
    expect(await prisma.customerWallet.count({ where: { storeId: s2.id } })).toBe(0);
    expect(await prisma.walletTransaction.count({ where: { storeId: s2.id } })).toBe(0);
    await prisma.user.deleteMany({ where: { id: owner2.id } });
  });

  it('a hard user delete is refused while the user has a wallet (money ledger survives)', async () => {
    const c = await newCustomer();
    await fund(c, 1);
    await expect(prisma.user.delete({ where: { id: c } })).rejects.toMatchObject({
      code: 'P2003',
    });
    expect(await balanceOf(c)).toBe(1);
  });

  it('a wallet write inside a caller transaction rolls back with it', async () => {
    const c = await newCustomer();
    await fund(c, 100);
    await expect(
      withMoneyTx(prisma, async tx => {
        await WalletService.applyEntry(
          {
            storeId,
            customerId: c,
            amount: -60,
            type: 'admin_adjust',
            idempotencyKey: uid('rolled-back'),
            note: 'x',
          },
          tx
        );
        throw new Error('caller aborted');
      })
    ).rejects.toThrow('caller aborted');
    expect(await balanceOf(c)).toBe(100);
    expect(await ledgerSum(c)).toBe(100);
  });
});
