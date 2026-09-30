/**
 * PaymentService.refund against a real Postgres, inside a request-shaped
 * tenant transaction — the only way its callers ever run it.
 *
 * Every existing refund test mocked Prisma, so none of them could see how the
 * method's writes relate to the transaction around them. Two defects lived
 * exactly there:
 *
 *  1. The post-provider write was `prisma.$transaction([...])`. `$transaction`
 *     is not routed to the ambient tenant transaction, so it opened a second
 *     connection that waited on the row lock the claim held in the first —
 *     while the first waited on it. Every gateway refund inside a request
 *     stalled for the full 30s transaction timeout, the claim rolled back, and
 *     then the status flip committed with the old balance (P2028 to the
 *     caller, after the money had left).
 *  2. The claim, the status flip and the refund id all lived in the request
 *     transaction, which rolls back on any 5xx. A failure after the provider
 *     paid out erased every record of it, so the retry paid again.
 *
 * The provider is the only thing stubbed: `TapPaymentProvider.prototype.refund`.
 * Self-skips without a real DATABASE_URL, like every DB-direct test here.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { runInTenantContext, withRlsBypass } from '@force/database';

vi.mock('@api/services/encryption.service', () => ({
  encryption: { decrypt: (v: string) => v, encrypt: (v: string) => v },
}));

import { PaymentService } from '@api/services/payment-providers/payment.factory';
import { ReturnService } from '@api/services/return.service';
import { TapPaymentProvider } from '@api/services/payment-providers/tap.provider';
import { ProviderRejectedError } from '@api/services/payment-providers/refund-outcome';

const hasDb =
  !!process.env.DATABASE_URL && !process.env.DATABASE_URL.includes('localhost:5432/test_db');

describe.skipIf(!hasDb)('PaymentService.refund — transaction boundaries (real Postgres)', () => {
  const suffix = `${Date.now()}-${process.pid}-${Math.random().toString(36).substring(7)}`;
  let storeId: string;
  let productId: string;
  let seq = 0;

  beforeAll(async () => {
    await withRlsBypass(async tx => {
      const owner = await tx.user.create({
        data: {
          email: `rtb-owner-${suffix}@example.com`,
          passwordHash: 'not-a-real-hash',
          role: 'store_admin',
          firstName: 'RTB',
          lastName: 'Owner',
        },
      });
      const store = await tx.store.create({
        data: {
          name: 'rtb-test-store',
          slug: `rtb-test-${suffix}`,
          template: 'modern',
          currency: 'KWD',
          ownerId: owner.id,
        },
      });
      storeId = store.id;
      await tx.paymentConfig.create({
        data: {
          storeId,
          provider: 'tap',
          isEnabled: true,
          isDefault: true,
          apiKey: 'sk_test_rtb',
          testMode: true,
        },
      });
      const product = await tx.product.create({
        data: {
          storeId,
          name: `rtb-product-${suffix}`,
          slug: `rtb-product-${suffix}`,
          price: 5000,
          inventory: 10,
          status: 'active',
        },
      });
      productId = product.id;
    });
  });

  afterAll(async () => {
    await withRlsBypass(async tx => {
      await tx.paymentEvent.deleteMany({ where: { storeId } }).catch(() => {});
      await tx.returnItem.deleteMany({ where: { return: { storeId } } }).catch(() => {});
      await tx.return.deleteMany({ where: { storeId } }).catch(() => {});
      await tx.payment.deleteMany({ where: { order: { storeId } } }).catch(() => {});
      await tx.order.deleteMany({ where: { storeId } }).catch(() => {});
      await tx.paymentConfig.deleteMany({ where: { storeId } }).catch(() => {});
      await tx.product.deleteMany({ where: { storeId } }).catch(() => {});
      await tx.store.deleteMany({ where: { id: storeId } }).catch(() => {});
      await tx.user.deleteMany({ where: { email: { contains: suffix } } }).catch(() => {});
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** A fresh paid order + completed Tap payment per test (retry-safe ids). */
  async function paidOrder(amount = 5000) {
    const n = `${suffix}-${++seq}-${Math.random().toString(36).substring(7)}`;
    return withRlsBypass(async tx => {
      const order = await tx.order.create({
        data: {
          storeId,
          orderNumber: `RTB-${n}`,
          status: 'delivered',
          paymentStatus: 'paid',
          subtotal: amount,
          total: amount,
          shippingAddress: {},
          billingAddress: {},
          items: {
            create: [
              {
                productId,
                productName: 'rtb-product',
                quantity: 1,
                price: amount,
                total: amount,
              },
            ],
          },
        },
      });
      const payment = await tx.payment.create({
        data: {
          orderId: order.id,
          provider: 'tap',
          status: 'completed',
          amount,
          transactionId: `chg_${n}`,
        },
      });
      return { orderId: order.id, paymentId: payment.id, transactionId: payment.transactionId! };
    });
  }

  const readPayment = (id: string) =>
    withRlsBypass(tx => tx.payment.findUniqueOrThrow({ where: { id } }));
  const readOrder = (id: string) =>
    withRlsBypass(tx => tx.order.findUniqueOrThrow({ where: { id } }));
  const eventTypes = async (paymentId: string) =>
    (
      await withRlsBypass(tx =>
        tx.paymentEvent.findMany({ where: { paymentId }, orderBy: { occurredAt: 'asc' } })
      )
    ).map(e => e.eventType);

  function providerPays(refundId: string) {
    return vi.spyOn(TapPaymentProvider.prototype, 'refund').mockImplementation(async req => ({
      success: true,
      provider: 'tap',
      refundId,
      transactionId: req.transactionId,
      amount: req.amount ?? 0,
      status: 'pending',
    }));
  }

  /** Stand-in for a tenant-scoped HTTP request: one transaction around it all. */
  const inRequest = <T>(fn: () => Promise<T>) => runInTenantContext(storeId, fn);

  it('completes promptly inside a request transaction and commits its record', async () => {
    const { paymentId, transactionId } = await paidOrder();
    const spy = providerPays(`rf-a-${suffix}`);

    const started = Date.now();
    await inRequest(() => PaymentService.refund({ transactionId, amount: 2000 }));
    const elapsed = Date.now() - started;

    expect(spy).toHaveBeenCalledOnce();
    // The old post-provider `$transaction` waited on the claim's row lock
    // until the request transaction's 30s timeout.
    expect(elapsed, 'a refund must not wait on its own row lock').toBeLessThan(10_000);

    const payment = await readPayment(paymentId);
    expect(payment.refundedAmount).toBe(2000);
    expect(payment.status).toBe('partially_refunded');
    expect(payment.refundId).toBe(`rf-a-${suffix}`);
    expect(await eventTypes(paymentId)).toEqual(['refund_initiated', 'refund_completed']);
  }, 60_000);

  it('keeps the refund on record when the request rolls back afterwards', async () => {
    const { orderId, paymentId, transactionId } = await paidOrder();
    providerPays(`rf-b-${suffix}`);

    await expect(
      inRequest(async () => {
        await PaymentService.refund({ transactionId });
        // Anything after the provider paid out — an Inngest enqueue blip, a
        // failed completion write — turns the response into a 5xx, and the
        // request transaction rolls back.
        throw new Error('a later step in the request failed');
      })
    ).rejects.toThrow('a later step in the request failed');

    const payment = await readPayment(paymentId);
    expect(payment.status, 'the money left — the payment must say so').toBe('refunded');
    expect(payment.refundedAmount).toBe(5000);
    expect(payment.refundId).toBe(`rf-b-${suffix}`);
    expect((await readOrder(orderId)).status).toBe('refunded');
  });

  it('refuses a second refund under the same key once the first may have gone out', async () => {
    const { paymentId, transactionId } = await paidOrder();
    const spy = providerPays(`rf-c-${suffix}`);
    const refundKey = `return:rtb-${suffix}-${seq}`;

    // First attempt pays out, then its request rolls back — exactly what
    // leaves a return retryable while the refund stands.
    await expect(
      inRequest(async () => {
        await PaymentService.refund({ transactionId, amount: 1000, refundKey });
        throw new Error('completion write failed');
      })
    ).rejects.toThrow('completion write failed');

    await expect(
      inRequest(() => PaymentService.refund({ transactionId, amount: 1000, refundKey }))
    ).rejects.toMatchObject({ code: 'REFUND_ALREADY_ISSUED' });

    expect(spy, 'the retry must never reach the provider').toHaveBeenCalledOnce();
    // And the refused retry left the balance alone.
    expect((await readPayment(paymentId)).refundedAmount).toBe(1000);
  });

  it('a different key on the same payment is still refundable', async () => {
    const { paymentId, transactionId } = await paidOrder();
    providerPays(`rf-d-${suffix}`);

    await inRequest(() =>
      PaymentService.refund({ transactionId, amount: 1000, refundKey: `return:one-${seq}` })
    );
    await inRequest(() =>
      PaymentService.refund({ transactionId, amount: 1000, refundKey: `return:two-${seq}` })
    );

    expect((await readPayment(paymentId)).refundedAmount).toBe(2000);
  });

  it('keeps the claim when the provider gives no clear answer', async () => {
    const { paymentId, transactionId } = await paidOrder();
    vi.spyOn(TapPaymentProvider.prototype, 'refund').mockRejectedValue(
      new Error('The operation was aborted due to timeout')
    );

    await expect(
      inRequest(() => PaymentService.refund({ transactionId, amount: 2000 }))
    ).rejects.toMatchObject({ code: 'PROVIDER_REFUND_INDETERMINATE' });

    const payment = await readPayment(paymentId);
    // The refund may have executed. Resetting the balance here is what let a
    // timeout become a second real refund.
    expect(payment.refundedAmount).toBe(2000);
    expect(await eventTypes(paymentId)).toEqual(['refund_initiated', 'refund_indeterminate']);
  });

  it('releases the claim when the provider refuses', async () => {
    const { paymentId, transactionId } = await paidOrder();
    vi.spyOn(TapPaymentProvider.prototype, 'refund').mockRejectedValue(
      new ProviderRejectedError('Refund amount exceeds the captured amount', 400)
    );

    await expect(
      inRequest(() => PaymentService.refund({ transactionId, amount: 2000 }))
    ).rejects.toBeInstanceOf(ProviderRejectedError);

    const payment = await readPayment(paymentId);
    expect(payment.refundedAmount).toBe(0);
    expect(payment.status).toBe('completed');
    expect(await eventTypes(paymentId)).toEqual(['refund_initiated', 'refund_failed']);
  });

  describe('through ReturnService.complete', () => {
    /** A received return covering `qty` of the order's single line. */
    async function receivedReturn(orderId: string) {
      const n = `${suffix}-${++seq}-${Math.random().toString(36).substring(7)}`;
      return withRlsBypass(async tx => {
        const line = await tx.orderItem.findFirstOrThrow({ where: { orderId } });
        const customer = await tx.user.create({
          data: {
            email: `rtb-cust-${n}@example.com`,
            passwordHash: 'not-a-real-hash',
            role: 'customer',
            firstName: 'RTB',
            lastName: 'Customer',
          },
        });
        return tx.return.create({
          data: {
            storeId,
            orderId,
            customerId: customer.id,
            returnNumber: `RET-RTB-${n}`,
            type: 'return',
            status: 'received',
            reason: 'defective',
            refundAmount: line.total,
            items: {
              create: [
                {
                  orderItemId: line.id,
                  productId,
                  productName: 'rtb-product',
                  quantity: line.quantity,
                },
              ],
            },
          },
        });
      });
    }

    it("a FULL return on 'original' completes promptly and reverses the order", async () => {
      const { orderId, paymentId } = await paidOrder();
      const ret = await receivedReturn(orderId);
      const spy = providerPays(`rf-e-${suffix}`);

      const started = Date.now();
      await inRequest(() => ReturnService.complete(storeId, ret.id, 'admin', 'original'));

      // The order flip commits on PaymentService's own transaction while the
      // request holds the order's returns lock — a row lock there would wait
      // on itself.
      expect(Date.now() - started).toBeLessThan(10_000);
      expect(spy).toHaveBeenCalledOnce();
      expect((await readOrder(orderId)).status).toBe('refunded');
      expect((await readPayment(paymentId)).status).toBe('refunded');
      const after = await withRlsBypass(tx =>
        tx.return.findUniqueOrThrow({ where: { id: ret.id } })
      );
      expect(after.status).toBe('completed');
    }, 60_000);

    // issue 2002 — an indeterminate gateway refund left a claim with no
    // terminal state a human could reach, so the stuck-claim sweep alerted it
    // for a week. Completing the return "record only" now settles it.
    it('a record-only completion after an indeterminate refund settles the open claim', async () => {
      const { orderId, paymentId } = await paidOrder();
      const ret = await receivedReturn(orderId);
      vi.spyOn(TapPaymentProvider.prototype, 'refund').mockRejectedValue(
        new Error('The operation was aborted due to timeout')
      );

      await expect(
        inRequest(() => ReturnService.complete(storeId, ret.id, 'admin', 'original'))
      ).rejects.toMatchObject({ code: 'PROVIDER_REFUND_INDETERMINATE' });
      const refunded = (await readPayment(paymentId)).refundedAmount;
      expect(await eventTypes(paymentId)).toEqual(['refund_initiated', 'refund_indeterminate']);

      await inRequest(() => ReturnService.complete(storeId, ret.id, 'admin', 'manual'));

      const events = await withRlsBypass(tx =>
        tx.paymentEvent.findMany({ where: { paymentId }, orderBy: { occurredAt: 'asc' } })
      );
      const claim = events.find(e => e.eventType === 'refund_initiated')!;
      const settled = events.find(e => e.eventType === 'refund_reconciled');
      expect(settled, 'the claim must get a terminal state').toBeDefined();
      expect((settled!.details as Record<string, unknown>).claimId).toBe(
        (claim.details as Record<string, unknown>).claimId
      );
      expect((settled!.details as Record<string, unknown>).reason).toBe('reconciled_by_merchant');
      // Records only — the balance the claim counted is unchanged.
      expect((await readPayment(paymentId)).refundedAmount).toBe(refunded);
    });

    it('a retry after the request rolled back is refused, and a manual method records it', async () => {
      // Two lines (3000 + 2000 of a 5000 payment), so returning one is partial.
      const { orderId, paymentId } = await paidOrder();
      await withRlsBypass(async tx => {
        await tx.orderItem.updateMany({ where: { orderId }, data: { price: 3000, total: 3000 } });
        await tx.orderItem.create({
          data: {
            orderId,
            productId,
            productName: 'rtb-kept',
            quantity: 1,
            price: 2000,
            total: 2000,
          },
        });
      });
      const ret = await receivedReturn(orderId);
      const spy = providerPays(`rf-f-${suffix}`);

      await expect(
        inRequest(async () => {
          await ReturnService.complete(storeId, ret.id, 'admin', 'original');
          throw new Error('response failed after the refund');
        })
      ).rejects.toThrow('response failed after the refund');

      // The return rolled back to 'received'; the refund did not.
      expect(
        (await withRlsBypass(tx => tx.return.findUniqueOrThrow({ where: { id: ret.id } }))).status
      ).toBe('received');
      const refunded = (await readPayment(paymentId)).refundedAmount;
      expect(refunded).toBeGreaterThan(0);

      await expect(
        inRequest(() => ReturnService.complete(storeId, ret.id, 'admin', 'original'))
      ).rejects.toMatchObject({ code: 'REFUND_ALREADY_ISSUED' });
      expect(spy, 'the customer must not be paid twice').toHaveBeenCalledOnce();

      // The preview tells the admin the same thing before they try.
      const preview = await inRequest(() => ReturnService.refundPreview(storeId, ret.id));
      expect(preview.gateway).toMatchObject({
        available: false,
        unavailableReason: 'REFUND_ALREADY_ISSUED',
      });

      await inRequest(() => ReturnService.complete(storeId, ret.id, 'admin', 'manual'));
      expect(
        (await withRlsBypass(tx => tx.return.findUniqueOrThrow({ where: { id: ret.id } }))).status
      ).toBe('completed');
      expect((await readPayment(paymentId)).refundedAmount).toBe(refunded);
    });
  });
});
