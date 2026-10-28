/**
 * order/created fire-once idempotency guard (integration)
 *
 * Regression test for the payment-webhook Inngest offload blast-radius fix
 * (PR #382). order/created can be enqueued for the SAME paid order by BOTH the
 * customer-return confirm path AND the (now-async) payment webhook consumer, and
 * Inngest delivers at-least-once. The order-created fn must therefore fan out
 * EXACTLY ONCE per order — both the admin-dashboard OneSignal push and the
 * separate orders-app push live inside that one fn, so a double-fire would
 * double-notify both apps + double-email the customer.
 *
 * The guarantee is the atomic claim on Order.orderCreatedNotifiedAt:
 *   UPDATE orders SET order_created_notified_at = now()
 *   WHERE id = $1 AND order_created_notified_at IS NULL
 * The fn proceeds only when this matches 1 row; any later enqueue matches 0 and
 * skips the whole fanout. This test proves that primitive dedupes under the
 * exact "two enqueues for one order" shape, including a real concurrent race.
 *
 * Mirrors rls-async-context.test.ts: DB-direct, creates its own store + order,
 * cleans up, and only runs when a real DATABASE_URL is present (CI / integration
 * env) — skipped against the localhost test_db placeholder.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { prisma, runInTenantContext, withRlsBypass } from '@ebda/database';

const hasDb =
  !!process.env.DATABASE_URL && !process.env.DATABASE_URL.includes('localhost:5432/test_db');

/** The exact atomic claim the order-created fn uses (see order-created.ts). */
async function claimOrderCreated(storeId: string, orderId: string): Promise<number> {
  return runInTenantContext(storeId, async () => {
    const res = await prisma.order.updateMany({
      where: { id: orderId, orderCreatedNotifiedAt: null },
      data: { orderCreatedNotifiedAt: new Date() },
    });
    return res.count;
  });
}

describe.skipIf(!hasDb)('order/created fire-once idempotency', () => {
  let storeId: string;
  let orderId: string;
  const suffix = `${Date.now()}-${process.pid}-${Math.random().toString(36).substring(7)}`;

  beforeAll(async () => {
    await withRlsBypass(async tx => {
      const owner = await tx.user.create({
        data: {
          email: `oc-owner-${suffix}@example.com`,
          passwordHash: 'not-a-real-hash',
          role: 'store_admin',
          firstName: 'OC',
          lastName: 'Owner',
        },
      });

      const store = await tx.store.create({
        data: {
          name: 'oc-test-store',
          slug: `oc-test-${suffix}`,
          template: 'qamar',
          currency: 'EGP',
          ownerId: owner.id,
        },
      });
      storeId = store.id;

      const order = await tx.order.create({
        data: {
          storeId,
          orderNumber: `OC-TEST-${suffix}`,
          status: 'confirmed',
          paymentStatus: 'paid',
          subtotal: 1000,
          total: 1000,
          shippingAddress: {},
          billingAddress: {},
          // orderCreatedNotifiedAt intentionally left null (the un-notified state).
        },
      });
      orderId = order.id;
    });
  });

  afterAll(async () => {
    await withRlsBypass(async tx => {
      await tx.order
        .deleteMany({ where: { orderNumber: { startsWith: 'OC-TEST-' } } })
        .catch(() => {});
      await tx.store.deleteMany({ where: { slug: { startsWith: 'oc-test-' } } }).catch(() => {});
      await tx.user.deleteMany({ where: { email: { startsWith: 'oc-owner-' } } }).catch(() => {});
    });
  });

  it('first claim wins (count=1), a second claim is a no-op (count=0)', async () => {
    const first = await claimOrderCreated(storeId, orderId);
    expect(first).toBe(1);

    const second = await claimOrderCreated(storeId, orderId);
    expect(second).toBe(0);
  });

  it('stamps orderCreatedNotifiedAt exactly once', async () => {
    const row = await withRlsBypass(tx =>
      tx.order.findUnique({
        where: { id: orderId },
        select: { orderCreatedNotifiedAt: true },
      })
    );
    expect(row?.orderCreatedNotifiedAt).toBeInstanceOf(Date);
  });

  it('a concurrent double-enqueue claims exactly once (both fire at the same time)', async () => {
    // Fresh order so we can race two claims with no prior winner.
    const raceSuffix = `${suffix}-race`;
    const raceOrderId = await withRlsBypass(async tx => {
      const o = await tx.order.create({
        data: {
          storeId,
          orderNumber: `OC-TEST-${raceSuffix}`,
          status: 'confirmed',
          paymentStatus: 'paid',
          subtotal: 500,
          total: 500,
          shippingAddress: {},
          billingAddress: {},
        },
      });
      return o.id;
    });

    const [a, b] = await Promise.all([
      claimOrderCreated(storeId, raceOrderId),
      claimOrderCreated(storeId, raceOrderId),
    ]);
    // Exactly one of the two concurrent claims wins — total claimed === 1.
    expect(a + b).toBe(1);
  });
});
