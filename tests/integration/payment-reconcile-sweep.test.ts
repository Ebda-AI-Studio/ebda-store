/**
 * payment-reconcile-sweep (adversarial audit P2, Task 9).
 *
 * A CAPTURED payment on a CANCELLED order is money taken for an order that
 * will never ship. The webhook handler now refuses to create that state on
 * our side (order-transition assert BEFORE the payment write), but the
 * capture can still land at the provider in the race window around a cancel
 * — so this sweep alerts finance, exactly once per payment, via a durable
 * reconciliation PaymentEvent marker.
 *
 * DB-direct integration test with a mocked alerts service.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

const h = vi.hoisted(() => ({ sendAlert: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@api/services/alerts.service', () => ({ sendAlert: h.sendAlert }));

import { withRlsBypass } from '@ebda/database';
import { handlePaymentReconcileSweep } from '@api/lib/inngest/functions/payment-reconcile-sweep';

const hasDb =
  !!process.env.DATABASE_URL && !process.env.DATABASE_URL.includes('localhost:5432/test_db');

const stepStub = { run: <T>(_id: string, fn: () => Promise<T>) => fn() };

describe.skipIf(!hasDb)('payment-reconcile-sweep', () => {
  const suffix = `${Date.now()}-${process.pid}-${Math.random().toString(36).substring(7)}`;
  let storeId: string;
  let cancelledOrderId: string;
  let mismatchPaymentId: string;

  beforeAll(async () => {
    await withRlsBypass(async tx => {
      const owner = await tx.user.create({
        data: {
          email: `prs-owner-${suffix}@example.com`,
          passwordHash: 'not-a-real-hash',
          role: 'store_admin',
          firstName: 'PRS',
          lastName: 'Owner',
        },
      });
      const store = await tx.store.create({
        data: {
          name: 'prs-test-store',
          slug: `prs-test-${suffix}`,
          template: 'modern',
          currency: 'EGP',
          ownerId: owner.id,
        },
      });
      storeId = store.id;

      // The mismatch: cancelled order carrying a completed payment.
      const cancelled = await tx.order.create({
        data: {
          storeId,
          orderNumber: `PRS-MIS-${suffix}`,
          status: 'cancelled',
          paymentStatus: 'unpaid',
          subtotal: 5000,
          total: 5000,
          shippingAddress: {},
          billingAddress: {},
        },
      });
      cancelledOrderId = cancelled.id;
      mismatchPaymentId = (
        await tx.payment.create({
          data: {
            orderId: cancelledOrderId,
            provider: 'paymob',
            status: 'completed',
            amount: 5000,
            currency: 'EGP',
            transactionId: `prs-txn-${suffix}`,
          },
        })
      ).id;

      // Control: a HEALTHY confirmed order with a completed payment — must
      // never be flagged.
      const healthy = await tx.order.create({
        data: {
          storeId,
          orderNumber: `PRS-OK-${suffix}`,
          status: 'confirmed',
          paymentStatus: 'paid',
          subtotal: 5000,
          total: 5000,
          shippingAddress: {},
          billingAddress: {},
        },
      });
      await tx.payment.create({
        data: {
          orderId: healthy.id,
          provider: 'paymob',
          status: 'completed',
          amount: 5000,
          currency: 'EGP',
          transactionId: `prs-txn-ok-${suffix}`,
        },
      });
    });
  });

  afterAll(async () => {
    await withRlsBypass(async tx => {
      await tx.paymentEvent.deleteMany({ where: { storeId } }).catch(() => {});
      await tx.payment.deleteMany({ where: { order: { storeId } } }).catch(() => {});
      await tx.order.deleteMany({ where: { storeId } }).catch(() => {});
      await tx.store.deleteMany({ where: { id: storeId } }).catch(() => {});
      await tx.user.deleteMany({ where: { email: { contains: suffix } } }).catch(() => {});
    });
  });

  it('alerts the captured-on-cancelled mismatch and records a durable reconciliation marker', async () => {
    h.sendAlert.mockClear();
    const result = await handlePaymentReconcileSweep(stepStub);

    expect(result.alerted).toBeGreaterThanOrEqual(1);
    const call = h.sendAlert.mock.calls.find(c => c[0]?.context?.paymentId === mismatchPaymentId);
    expect(call).toBeTruthy();
    expect(call![0]).toMatchObject({
      level: 'p0',
      source: 'payment.completed_on_cancelled_order',
    });
    // The healthy confirmed order must not be flagged.
    const flaggedOrders = h.sendAlert.mock.calls.map(c => c[0]?.context?.orderId);
    expect(flaggedOrders).toEqual([cancelledOrderId]);

    const marker = await withRlsBypass(tx =>
      tx.paymentEvent.findFirst({
        where: { paymentId: mismatchPaymentId, eventType: 'reconciliation' },
      })
    );
    expect(marker).toBeTruthy();
  });

  it('does not re-alert an already-reported mismatch on the next tick', async () => {
    h.sendAlert.mockClear();
    const result = await handlePaymentReconcileSweep(stepStub);
    expect(result.alerted).toBe(0);
    expect(h.sendAlert).not.toHaveBeenCalled();
  });
});
