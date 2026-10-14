/**
 * Loyalty redemption at checkout — integration (real DB).
 *
 * Proves the money-critical invariants end-to-end against Postgres:
 *  1. Golden path: OrderService.create with pointsToRedeem decrements the
 *     balance, folds the discount into the order total, and logs a
 *     `redeem_discount` transaction — all atomic with the order.
 *  2. Refund re-credit: the order/refunded fanout re-credits the redeemed points
 *     exactly once (idempotent across repeat refund calls).
 *  3. Guest checkout ignores pointsToRedeem entirely (no customer, no burn).
 *  4. Concurrent double-redeem race: two redeemPoints calls for the same
 *     balance — only one succeeds; the balance never goes negative.
 *
 * Self-contained: creates its own owner/store/customer/products and cleans up.
 * Requires a real DATABASE_URL (CI integration job / local PG17 cluster).
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { prisma } from '@ebda/database';
import { OrderService } from '@api/services/order.service';
import { LoyaltyService } from '@api/services/loyalty.service';
import { CartService } from '@api/services/cart.service';
import { handleOrderRefunded } from '@api/lib/inngest/functions/order-refunded';

// Passthrough Inngest step (runs each step.run body inline) so integration
// tests can drive the order/refunded fanout synchronously — post-redesign the
// loyalty re-credit lives in the fanout, not inline in applyRefundEffects.
const stepStub = { run: async <T>(_id: string, fn: () => Promise<T>): Promise<T> => fn() };

const TAG = `loyalty-redeem-${Date.now()}`;

describe('loyalty redemption — integration', () => {
  let storeId: string;
  let ownerId: string;
  let customerId: string;
  let productId: string;

  beforeAll(async () => {
    const owner = await prisma.user.create({
      data: {
        email: `${TAG}-owner@example.test`,
        passwordHash: 'x'.repeat(60),
        firstName: 'Owner',
        lastName: 'Test',
        role: 'store_admin',
        status: 'active',
        emailVerified: true,
      },
    });
    ownerId = owner.id;

    const store = await prisma.store.create({
      data: {
        name: 'Loyalty Redeem Store',
        slug: `${TAG}-store`,
        ownerId: owner.id,
        status: 'active',
        // Loyalty must be on AND the feature gated true. We set both the
        // store flag and an explicit StoreFeature override so isFeatureEnabled
        // resolves true regardless of plan defaults.
        loyaltyEnabled: true,
        loyaltySettings: {
          pointsValue: 1, // 1 fil per point
          minRedeemPoints: 500,
          maxRedeemPercentage: 100, // allow up to full subtotal for the test
        },
      },
    });
    storeId = store.id;

    await prisma.storeFeature.create({
      data: { storeId, featureKey: 'loyalty', enabled: true, enabledBy: ownerId },
    });

    const customer = await prisma.user.create({
      data: {
        email: `${TAG}-cust@example.test`,
        passwordHash: 'x'.repeat(60),
        firstName: 'Cust',
        lastName: 'Test',
        role: 'customer',
        status: 'active',
        emailVerified: true,
      },
    });
    customerId = customer.id;

    const product = await prisma.product.create({
      data: {
        storeId,
        name: 'Redeemable Widget',
        slug: `${TAG}-widget`,
        price: 10_000, // 10 EGP in piastres
        inventory: 1000,
        trackInventory: false, // skip inventory bookkeeping noise
        status: 'active',
      },
    });
    productId = product.id;
  });

  afterAll(async () => {
    await prisma.loyaltyTransaction.deleteMany({ where: { storeId } });
    await prisma.loyaltyPoints.deleteMany({ where: { storeId } });
    await prisma.orderItem.deleteMany({ where: { order: { storeId } } });
    await prisma.order.deleteMany({ where: { storeId } });
    await prisma.cartItem.deleteMany({ where: { cart: { storeId } } });
    await prisma.cart.deleteMany({ where: { storeId } });
    await prisma.product.deleteMany({ where: { storeId } });
    await prisma.storeFeature.deleteMany({ where: { storeId } });
    await prisma.store.deleteMany({ where: { id: storeId } });
    await prisma.user.deleteMany({ where: { id: { in: [ownerId, customerId] } } });
    await prisma.$disconnect();
  });

  // Fresh loyalty balance before each test.
  beforeEach(async () => {
    await prisma.loyaltyTransaction.deleteMany({ where: { storeId } });
    await prisma.loyaltyPoints.deleteMany({ where: { storeId } });
    await prisma.orderItem.deleteMany({ where: { order: { storeId } } });
    await prisma.order.deleteMany({ where: { storeId } });
    await prisma.cartItem.deleteMany({ where: { cart: { storeId } } });
    await prisma.cart.deleteMany({ where: { storeId } });
  });

  async function giveCustomerPoints(points: number) {
    await prisma.loyaltyPoints.create({
      data: { storeId, customerId, points, totalEarned: points, tier: 'bronze' },
    });
  }

  async function seedCart(sessionId: string, qty: number, withCustomer: boolean) {
    const cart = await CartService.getOrCreate(
      storeId,
      sessionId,
      withCustomer ? customerId : undefined
    );
    await prisma.cartItem.create({
      data: { cartId: cart.id, productId, quantity: qty },
    });
  }

  const baseOrderData = {
    shippingAddress: {
      firstName: 'Cust',
      lastName: 'Test',
      address1: 'Block 1',
      city: 'Cairo',
      state: 'Capital',
      postalCode: '00000',
      country: 'EG',
      phone: '96551234567',
    },
    paymentMethod: 'paymob', // non-COD → no inngest/socket fanout at create
  };

  it('golden path: decrements balance, applies discount to total, logs redeem_discount', async () => {
    await giveCustomerPoints(2000);
    const sessionId = `${TAG}-golden`;
    await seedCart(sessionId, 1, true); // 1 x 10 EGP = 10000 piastres subtotal

    const order = await OrderService.create(storeId, customerId, sessionId, {
      ...baseOrderData,
      pointsToRedeem: 1500,
    });

    // 1500 points @ 1 fil = 1500 piastres discount; subtotal 10000 → total 8500
    // (tax 0, shipping 0 for this store).
    expect(order.subtotal).toBe(10_000);
    expect(order.loyaltyPointsRedeemed).toBe(1500);
    expect(order.loyaltyDiscount).toBe(1500);
    expect(order.discount).toBe(1500);
    expect(order.total).toBe(8500);

    // Balance decremented atomically.
    const balance = await prisma.loyaltyPoints.findUnique({
      where: { storeId_customerId: { storeId, customerId } },
    });
    expect(balance?.points).toBe(500); // 2000 - 1500
    expect(balance?.totalRedeemed).toBe(1500);

    // redeem_discount transaction logged with the order id.
    const redeemTx = await prisma.loyaltyTransaction.findFirst({
      where: { storeId, customerId, orderId: order.id, type: 'redeem_discount' },
    });
    expect(redeemTx).toBeTruthy();
    expect(redeemTx?.points).toBe(-1500);
  });

  it('caps the loyalty discount at the subtotal and reduces burned points', async () => {
    await giveCustomerPoints(50_000);
    const sessionId = `${TAG}-cap`;
    await seedCart(sessionId, 1, true); // 10000 piastres subtotal

    const order = await OrderService.create(storeId, customerId, sessionId, {
      ...baseOrderData,
      pointsToRedeem: 50_000, // would be 50000 piastres, capped at 10000
    });

    expect(order.loyaltyDiscount).toBe(10_000);
    expect(order.loyaltyPointsRedeemed).toBe(10_000); // pointsValue 1 → 10000 points
    expect(order.total).toBe(0);

    const balance = await prisma.loyaltyPoints.findUnique({
      where: { storeId_customerId: { storeId, customerId } },
    });
    expect(balance?.points).toBe(40_000); // only 10000 burned
  });

  it('refund re-credits redeemed points exactly once (idempotent)', async () => {
    await giveCustomerPoints(2000);
    const sessionId = `${TAG}-refund`;
    await seedCart(sessionId, 1, true);

    const order = await OrderService.create(storeId, customerId, sessionId, {
      ...baseOrderData,
      pointsToRedeem: 1500,
    });

    let balance = await prisma.loyaltyPoints.findUnique({
      where: { storeId_customerId: { storeId, customerId } },
    });
    expect(balance?.points).toBe(500);

    // First refund → re-credit 1500.
    await handleOrderRefunded(order.id, storeId, false, false, stepStub);
    balance = await prisma.loyaltyPoints.findUnique({
      where: { storeId_customerId: { storeId, customerId } },
    });
    expect(balance?.points).toBe(2000); // 500 + 1500 back
    expect(balance?.totalRedeemed).toBe(0); // unwound

    // Second refund (partial→full scenario) → no double credit.
    await handleOrderRefunded(order.id, storeId, false, false, stepStub);
    balance = await prisma.loyaltyPoints.findUnique({
      where: { storeId_customerId: { storeId, customerId } },
    });
    expect(balance?.points).toBe(2000); // still 2000, not 3500

    // Exactly one re-credit adjust row.
    const recreditRows = await prisma.loyaltyTransaction.findMany({
      where: { storeId, orderId: order.id, type: 'adjust' },
    });
    expect(recreditRows).toHaveLength(1);
    expect(recreditRows[0].points).toBe(1500);
  });

  it('guest checkout ignores pointsToRedeem (no customer, no burn)', async () => {
    // Even if a guest somehow had points (they can't), no customerId means
    // the redemption is ignored entirely.
    const sessionId = `${TAG}-guest`;
    await seedCart(sessionId, 1, false);

    const order = await OrderService.create(storeId, undefined, sessionId, {
      ...baseOrderData,
      pointsToRedeem: 1500,
    });

    expect(order.loyaltyPointsRedeemed).toBeNull();
    expect(order.loyaltyDiscount).toBe(0);
    expect(order.discount).toBe(0);
    expect(order.total).toBe(10_000);
  });

  it('concurrent double-redeem race: only one succeeds, balance never negative', async () => {
    await giveCustomerPoints(1000); // only enough for ONE 1000-point redeem
    const o1 = 'race-order-1';
    const o2 = 'race-order-2';
    // Create two placeholder orders to satisfy the FK on loyalty_transactions.
    for (const num of [o1, o2]) {
      await prisma.order.create({
        data: {
          storeId,
          customerId,
          orderNumber: `${TAG}-${num}`,
          subtotal: 10_000,
          total: 10_000,
          shippingAddress: {},
          billingAddress: {},
        },
      });
    }
    const ord1 = await prisma.order.findFirst({ where: { orderNumber: `${TAG}-${o1}` } });
    const ord2 = await prisma.order.findFirst({ where: { orderNumber: `${TAG}-${o2}` } });

    const results = await Promise.allSettled([
      LoyaltyService.redeemPoints(storeId, customerId, ord1!.id, 1000),
      LoyaltyService.redeemPoints(storeId, customerId, ord2!.id, 1000),
    ]);

    const fulfilled = results.filter(r => r.status === 'fulfilled');
    const rejected = results.filter(r => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);

    const balance = await prisma.loyaltyPoints.findUnique({
      where: { storeId_customerId: { storeId, customerId } },
    });
    expect(balance?.points).toBe(0); // exactly one 1000-point burn
    expect(balance?.points).toBeGreaterThanOrEqual(0); // never negative

    // Exactly one redeem_discount transaction.
    const redeemTxs = await prisma.loyaltyTransaction.findMany({
      where: { storeId, customerId, type: 'redeem_discount' },
    });
    expect(redeemTxs).toHaveLength(1);
  });
});
