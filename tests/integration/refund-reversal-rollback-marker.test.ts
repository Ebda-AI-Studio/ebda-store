/**
 * rollbackForPaymentFailure must stamp `refundReversedAt` (integration)
 *
 * Regression test for the 2026-09-02 adversarial audit P0-4.
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
 * The fix stamps `refundReversedAt` inside the same transaction as the
 * reversal. This test pins the invariant the sweep depends on: after a
 * rollback, the order must NOT match the sweep's selection predicate.
 *
 * Mirrors order-created-idempotency.test.ts: DB-direct, seeds its own store,
 * cleans up, and only runs when a real DATABASE_URL is present.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { prisma, withRlsBypass } from '@force/database';
import { OrderService } from '../../apps/api/src/services/order.service';

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
  const START_INVENTORY = 10;
  const ORDER_QTY = 3;

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
          template: 'modern',
          currency: 'KWD',
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

      // A pending, unpaid order with no Payment rows — the exact shape the
      // rollback accepts (it returns early for cancelled / paid / progressed
      // orders).
      const order = await tx.order.create({
        data: {
          storeId,
          orderNumber: `RR-TEST-${suffix}`,
          status: 'pending',
          paymentStatus: 'unpaid',
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

  it('leaves no return_stock marker — the sweep must rely on refundReversedAt, not the marker type', async () => {
    // Documents WHY the fix is the timestamp and not a marker-type change:
    // the rollback deliberately records an 'adjustment', so a marker-based
    // sweep would still mis-read this order as un-reversed.
    const markers = await withRlsBypass(tx =>
      tx.inventoryHistory.findMany({
        where: { reference: orderId },
        select: { type: true },
      })
    );
    expect(markers.length).toBeGreaterThan(0);
    expect(markers.every(m => m.type === 'adjustment')).toBe(true);
  });
});
