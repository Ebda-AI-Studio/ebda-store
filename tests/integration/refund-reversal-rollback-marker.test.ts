/**
 * rollbackForPaymentFailure must record its reversal as DONE (integration)
 *
 * Regression test for the 2026-09-02 adversarial audit P0-4, extended after
 * `cancelled → refunded` was opened up in the status machine.
 *
 * `rollbackForPaymentFailure` IS a reversal: it restores inventory and releases
 * the coupon inline, then cancels the order. But it wrote its inventory marker
 * as `InventoryHistory.type='adjustment'` and left `Order.refundReversedAt`
 * null. `refund-reversal-stuck-sweep` selects on exactly that null and re-sends
 * `order/refunded`; the fanout's idempotency marker is `type='return_stock'`,
 * which never matches the rollback's 'adjustment' row — so the fanout restored
 * the stock a SECOND time and decremented the coupon again.
 *
 * That made stock inventable by anyone: place a guest order, POST
 * /payments/create naming an unconfigured provider (the factory throws and the
 * route's catch runs this rollback), wait one 15-minute cron cycle, repeat. It
 * also fired organically on every legitimate failed payment-create.
 *
 * The reversal is therefore recorded TWICE OVER, and this test pins both halves
 * because they guard different doors:
 *
 *   - `refundReversedAt` hides the order from `refund-reversal-stuck-sweep`,
 *     so the sweep never re-sends `order/refunded`.
 *   - the canonical `return_stock` / `coupon_reversed` markers make the FANOUT
 *     itself idempotent, for the deliveries the sweep has no say over.
 *
 * The second half became load-bearing when the machine started allowing
 * `cancelled → refunded`: an auto-cancelled order whose customer then pays the
 * still-live provider invoice can be refunded by finance, and that refund
 * webhook calls `applyRefundEffects` DIRECTLY (payment.factory) with
 * `restoreInventory: true`. No sweep is involved, so the timestamp never gets
 * a vote — only the markers stop the second reversal.
 *
 * Mirrors order-created-idempotency.test.ts: DB-direct, seeds its own store,
 * cleans up, and only runs when a real DATABASE_URL is present.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { prisma, withRlsBypass } from '@ebda/database';
import { OrderService } from '../../apps/api/src/services/order.service';
import { handleOrderRefunded } from '../../apps/api/src/lib/inngest/functions/order-refunded';

const hasDb =
  !!process.env.DATABASE_URL && !process.env.DATABASE_URL.includes('localhost:5432/test_db');

/** The exact predicate refund-reversal-stuck-sweep uses to find work to re-fire. */
async function sweepWouldSelect(orderId: string): Promise<boolean> {
  const rows = await withRlsBypass(tx =>
    tx.order.findMany({
      where: {
        id: orderId,
        status: { in: ['cancelled', 'refunded'] },
        refundReversedAt: null,
      },
      select: { id: true },
    })
  );
  return rows.length > 0;
}

describe.skipIf(!hasDb)('rollbackForPaymentFailure marks the reversal as done', () => {
  const suffix = `${Date.now()}-${process.pid}-${Math.random().toString(36).substring(7)}`;
  const sessionId = `rr-sess-${suffix}`;
  const couponCode = `RR-COUPON-${suffix}`;
  const START_INVENTORY = 10;
  const ORDER_QTY = 3;
  const START_COUPON_USES = 4;

  let storeId: string;
  let orderId: string;
  let productId: string;

  beforeAll(async () => {
    await withRlsBypass(async tx => {
      const owner = await tx.user.create({
        data: {
          email: `rr-owner-${suffix}@example.com`,
          passwordHash: 'not-a-real-hash',
          role: 'store_admin',
          firstName: 'RR',
          lastName: 'Owner',
        },
      });

      const store = await tx.store.create({
        data: {
          name: 'rr-test-store',
          slug: `rr-test-${suffix}`,
          template: 'qamar',
          currency: 'EGP',
          ownerId: owner.id,
        },
      });
      storeId = store.id;

      const product = await tx.product.create({
        data: {
          storeId,
          name: 'RR Test Product',
          slug: `rr-product-${suffix}`,
          price: 1000,
          inventory: START_INVENTORY,
          trackInventory: true,
        },
      });
      productId = product.id;

      // A coupon the order consumed at checkout, so the rollback's coupon
      // release (and its marker) is observable.
      await tx.coupon.create({
        data: {
          storeId,
          code: couponCode,
          name: 'RR Test Coupon',
          type: 'percentage',
          value: 10,
          usageCount: START_COUPON_USES,
        },
      });

      // A pending, unpaid order with no Payment rows — the exact shape the
      // rollback accepts (it returns early for cancelled / paid / progressed
      // orders).
      const order = await tx.order.create({
        data: {
          storeId,
          orderNumber: `RR-TEST-${suffix}`,
          status: 'pending',
          paymentStatus: 'unpaid',
          couponCode,
          subtotal: 1000 * ORDER_QTY,
          total: 1000 * ORDER_QTY,
          shippingAddress: {},
          billingAddress: {},
          items: {
            create: [
              {
                productId,
                productName: 'RR Test Product',
                quantity: ORDER_QTY,
                price: 1000,
                total: 1000 * ORDER_QTY,
              },
            ],
          },
        },
      });
      orderId = order.id;

      // The order reserved stock at creation time; mirror that so the
      // rollback's restore is observable.
      await tx.product.update({
        where: { id: productId },
        data: { inventory: START_INVENTORY - ORDER_QTY },
      });
    });
  });

  afterAll(async () => {
    await withRlsBypass(async tx => {
      await tx.inventoryHistory.deleteMany({ where: { storeId } }).catch(() => {});
      await tx.cart.deleteMany({ where: { storeId } }).catch(() => {});
      await tx.order
        .deleteMany({ where: { orderNumber: { startsWith: 'RR-TEST-' } } })
        .catch(() => {});
      await tx.product
        .deleteMany({ where: { slug: { startsWith: 'rr-product-' } } })
        .catch(() => {});
      await tx.store.deleteMany({ where: { slug: { startsWith: 'rr-test-' } } }).catch(() => {});
      await tx.user.deleteMany({ where: { email: { startsWith: 'rr-owner-' } } }).catch(() => {});
    });
  });

  it('restores the reserved stock exactly once', async () => {
    await OrderService.rollbackForPaymentFailure(storeId, orderId, sessionId);

    const product = await withRlsBypass(tx =>
      tx.product.findUniqueOrThrow({ where: { id: productId }, select: { inventory: true } })
    );
    expect(product.inventory).toBe(START_INVENTORY);
  });

  it('stamps refundReversedAt in the same transaction as the reversal', async () => {
    const order = await withRlsBypass(tx =>
      tx.order.findUniqueOrThrow({
        where: { id: orderId },
        select: { status: true, refundReversedAt: true },
      })
    );
    expect(order.status).toBe('cancelled');
    expect(order.refundReversedAt).toBeInstanceOf(Date);
  });

  it('is invisible to the stuck-reversal sweep, so the fanout cannot double-restore', async () => {
    expect(await sweepWouldSelect(orderId)).toBe(false);
  });

  it('writes the canonical return_stock marker the order/refunded fanout guards on', async () => {
    // The stamp is the SWEEP's guard; this marker is the FANOUT's guard.
    // Both are required — see the header. The rollback used to record an
    // 'adjustment', which the fanout's `type: 'return_stock'` idempotency
    // check never matched.
    const markers = await withRlsBypass(tx =>
      tx.inventoryHistory.findMany({
        where: { reference: orderId },
        select: { type: true, reason: true },
      })
    );
    expect(markers.length).toBeGreaterThan(0);
    expect(markers.every(m => m.type === 'return_stock')).toBe(true);
    // The reason keeps a payment-failure rollback distinguishable from a
    // genuine customer return despite sharing the type.
    expect(markers.every(m => m.reason === 'Order rollback — payment step failed')).toBe(true);
  });

  it('writes the canonical coupon_reversed marker so the refund cannot re-decrement', async () => {
    const marker = await withRlsBypass(tx =>
      tx.orderEvent.findFirst({
        where: { orderId, toStatus: 'coupon_reversed' },
        select: { id: true },
      })
    );
    expect(marker).not.toBeNull();
  });

  it('releases the coupon redemption exactly once', async () => {
    const coupon = await withRlsBypass(tx =>
      tx.coupon.findFirstOrThrow({ where: { storeId }, select: { usageCount: true } })
    );
    expect(coupon.usageCount).toBe(START_COUPON_USES - 1);
  });

  /**
   * The regression this pins: `cancelled → refunded` is a legal transition, so
   * a rolled-back order that the customer then pays (the still-live provider
   * invoice) and finance refunds reaches the `order/refunded` fanout directly
   * — no sweep, so `refundReversedAt` never gets a chance to gate it. Only the
   * markers stand between that refund and a second reversal. This asserts the
   * exact two reads the fanout performs both find their marker.
   */
  it('is idempotent against a later cancelled→refunded fanout — both guards hit', async () => {
    const [stockMarker, couponMarker] = await withRlsBypass(async tx => [
      // order-refunded.ts restore-inventory
      await tx.inventoryHistory.findFirst({
        where: { reference: orderId, type: 'return_stock', storeId },
        select: { id: true },
      }),
      // order-refunded.ts reverse-coupon
      await tx.orderEvent.findFirst({
        where: { storeId, orderId, toStatus: 'coupon_reversed' },
        select: { id: true },
      }),
    ]);
    expect(stockMarker).not.toBeNull();
    expect(couponMarker).not.toBeNull();
  });
});

/**
 * #1946 — every order rolled back BEFORE the canonical markers existed
 * (2026-04-25 → 2026-09-25) carries only an `adjustment` stock row with the
 * rollback reason, and no `coupon_reversed` event, although that rollback
 * restored the stock and released the coupon. Refunding one (auto-cancelled,
 * then paid on the still-live invoice, then refunded) runs the real fanout
 * here against Postgres: it must neither restock nor release the coupon again.
 */
describe.skipIf(!hasDb)('order/refunded on an order rolled back before the markers (#1946)', () => {
  const suffix = `${Date.now()}-${process.pid}-${Math.random().toString(36).substring(7)}`;
  const couponCode = `RRL-COUPON-${suffix}`;
  const INVENTORY_AFTER_ROLLBACK = 10;
  const COUPON_USES_AFTER_ROLLBACK = 4;
  let storeId: string;
  let orderId: string;
  let productId: string;

  beforeAll(async () => {
    await withRlsBypass(async tx => {
      const owner = await tx.user.create({
        data: {
          email: `rr-owner-legacy-${suffix}@example.com`,
          passwordHash: 'not-a-real-hash',
          role: 'store_admin',
          firstName: 'RR',
          lastName: 'Legacy',
        },
      });
      const store = await tx.store.create({
        data: {
          name: 'rr-legacy-store',
          slug: `rr-test-legacy-${suffix}`,
          template: 'qamar',
          currency: 'EGP',
          ownerId: owner.id,
        },
      });
      storeId = store.id;
      const product = await tx.product.create({
        data: {
          storeId,
          name: 'RR Legacy Product',
          slug: `rr-product-legacy-${suffix}`,
          price: 1000,
          inventory: INVENTORY_AFTER_ROLLBACK,
          trackInventory: true,
        },
      });
      productId = product.id;
      await tx.coupon.create({
        data: {
          storeId,
          code: couponCode,
          name: 'RR Legacy Coupon',
          type: 'percentage',
          value: 10,
          usageCount: COUPON_USES_AFTER_ROLLBACK,
        },
      });
      // The state the OLD rollback left: cancelled, stamped, stock already
      // back (inventory above), coupon already released (usage above).
      const order = await tx.order.create({
        data: {
          storeId,
          orderNumber: `RR-TEST-LEGACY-${suffix}`,
          status: 'cancelled',
          paymentStatus: 'unpaid',
          couponCode,
          subtotal: 3000,
          total: 3000,
          shippingAddress: {},
          billingAddress: {},
          refundReversedAt: new Date(),
          items: {
            create: [
              {
                productId,
                productName: 'RR Legacy Product',
                quantity: 3,
                price: 1000,
                total: 3000,
              },
            ],
          },
        },
      });
      orderId = order.id;
      await tx.inventoryHistory.create({
        data: {
          productId,
          storeId,
          type: 'adjustment',
          quantity: 3,
          previousStock: INVENTORY_AFTER_ROLLBACK - 3,
          newStock: INVENTORY_AFTER_ROLLBACK,
          reason: 'Order rollback — payment step failed',
          reference: orderId,
        },
      });
    });
  });

  afterAll(async () => {
    await withRlsBypass(async tx => {
      await tx.orderEvent.deleteMany({ where: { storeId } }).catch(() => {});
      await tx.inventoryHistory.deleteMany({ where: { storeId } }).catch(() => {});
      await tx.order.deleteMany({ where: { storeId } }).catch(() => {});
      await tx.coupon.deleteMany({ where: { storeId } }).catch(() => {});
      await tx.product.deleteMany({ where: { storeId } }).catch(() => {});
      await tx.store.deleteMany({ where: { id: storeId } }).catch(() => {});
      await tx.user
        .deleteMany({ where: { email: { startsWith: 'rr-owner-legacy-' } } })
        .catch(() => {});
    });
  });

  it('neither restocks nor releases the coupon a second time', async () => {
    const step = { run: async <T>(_id: string, fn: () => Promise<T>): Promise<T> => fn() };
    await handleOrderRefunded(orderId, storeId, true, false, step);

    const [product, coupon, returnRows] = await withRlsBypass(async tx => [
      await tx.product.findUnique({ where: { id: productId }, select: { inventory: true } }),
      await tx.coupon.findFirst({ where: { storeId, code: couponCode } }),
      await tx.inventoryHistory.count({
        where: { reference: orderId, storeId, type: 'return_stock' },
      }),
    ]);
    expect(product?.inventory).toBe(INVENTORY_AFTER_ROLLBACK);
    expect(coupon?.usageCount).toBe(COUPON_USES_AFTER_ROLLBACK);
    expect(returnRows).toBe(0);
  });
});
