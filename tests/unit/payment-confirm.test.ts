/**
 * payment-confirm.service unit tests
 *
 * Covers the idempotent mark-paid routine shared by the admin "Refresh
 * payment" button and the guest verify-on-return endpoint. Money code —
 * the contract under test is: PAID marks the order paid + fans out exactly
 * once; a redundant call is a no-op; non-paid statuses don't flip to paid.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock the inngest client so we can assert the fanout fires (or doesn't).
const inngestSend = vi.fn().mockResolvedValue(undefined);
vi.mock('@api/lib/inngest/client', () => ({
  inngest: { send: (...args: unknown[]) => inngestSend(...args) },
}));

// Mock prisma — $transaction just resolves the array of update promises.
const paymentUpdate = vi.fn().mockResolvedValue({});
const orderUpdate = vi.fn().mockResolvedValue({});
// The order write is now ONE conditional claim (payment-state-claims); `txn` counts those calls so the
// existing "the order write ran once / never ran" assertions keep their meaning.
const txn = vi.fn().mockResolvedValue(undefined);
const claims = { paid: 'claimed' as string, failed: 'claimed' as string };
vi.mock('@api/services/payment-state-claims', () => ({
  claimOrderPaid: (...a: unknown[]) => {
    txn('paid', ...a);
    return Promise.resolve(claims.paid);
  },
  claimOrderFailed: (...a: unknown[]) => {
    txn('failed', ...a);
    return Promise.resolve(claims.failed);
  },
}));
// Returns the order detail the "Payment received" push reads; null is fine for
// the reconciliation tests (the push is best-effort and never affects the result).
const orderFindUnique = vi.fn().mockResolvedValue({ status: 'pending' });
// The amount-mismatch alert path resolves the store name for the Telegram
// header — mock a store row so the alert-building code has something to read.
const storeFindUnique = vi.fn().mockResolvedValue({ name: 'Test Store' });
vi.mock('@ebda/database', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mod: Record<string, any> = {
    prisma: {
      payment: {
        update: (...a: unknown[]) => paymentUpdate(...a),
        updateMany: (...a: unknown[]) => paymentUpdate(...a),
      },
      order: {
        update: (...a: unknown[]) => orderUpdate(...a),
        findUnique: (...a: unknown[]) => orderFindUnique(...a),
      },
      store: { findUnique: (...a: unknown[]) => storeFindUnique(...a) },
      $transaction: (...a: unknown[]) => txn(...a),
    },
    // The "Payment received" merchant push wraps a lookup in runInTenantContext;
    // mock it as a pass-through that just runs the callback.
    runInTenantContext: (_storeId: string, fn: () => unknown) => fn(),
  };
  mod.withStore = (_id: string, fn: (tx: unknown) => unknown) => fn(mod.prisma);
  return mod;
});

// Mock the append-only event log — assert it's written, don't hit a DB.
const recordEvent = vi.fn().mockResolvedValue(undefined);
vi.mock('@api/services/payment-event.service', () => ({
  recordPaymentEvent: (...a: unknown[]) => recordEvent(...a),
}));

// Mock the alert channel — assert a P0 fires on a paid-amount mismatch
// without hitting Telegram/config.
const sendAlertMock = vi.fn().mockResolvedValue(undefined);
vi.mock('@api/services/alerts.service', () => ({
  sendAlert: (...a: unknown[]) => sendAlertMock(...a),
}));

import { confirmPaymentFromProviderStatus } from '@api/services/payment-confirm.service';
import type { PaymentStatusResponse } from '@api/services/payment-providers/types';

// `amount` mirrors `order.total` in piastres (see PaymentService.createPayment) —
// required so the paid-amount reconciliation gate has an expected value to
// compare against.
const basePayment = {
  id: 'pay_1',
  status: 'pending',
  provider: 'paymob',
  metadata: {},
  amount: 5000,
};

function statusResponse(
  status: PaymentStatusResponse['status'],
  overrides: Partial<PaymentStatusResponse> = {}
): PaymentStatusResponse {
  return {
    success: true,
    provider: 'paymob',
    transactionId: '215031900',
    invoiceId: '215031900',
    status,
    amount: 5000,
    currency: 'EGP',
    ...overrides,
  };
}

describe('confirmPaymentFromProviderStatus', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    claims.paid = 'claimed';
    claims.failed = 'claimed';
  });

  it('PAID + order currently unpaid → marks order paid and fires fanout ONCE', async () => {
    const result = await confirmPaymentFromProviderStatus({
      payment: basePayment,
      order: { id: 'ord_1', storeId: 'store_1', paymentStatus: 'unpaid', locale: 'ar' },
      providerStatus: statusResponse('completed'),
      source: 'guest_verify',
    });

    expect(result).toEqual({
      paymentStatus: 'paid',
      providerStatus: 'completed',
      statusChanged: true,
    });
    expect(txn).toHaveBeenCalledTimes(1);
    expect(recordEvent).toHaveBeenCalledTimes(1);
    expect(inngestSend).toHaveBeenCalledTimes(1);
    // Fanout carries the order's locale + provider so emails/push render right.
    expect(inngestSend).toHaveBeenCalledWith({
      name: 'order/created',
      data: {
        orderId: 'ord_1',
        storeId: 'store_1',
        paymentMethod: 'paymob',
        locale: 'ar',
      },
    });
  });

  it('PAID but the claim is LOST to a concurrent webhook → no payment write, no fanout (M-049)', async () => {
    claims.paid = 'already_paid';
    const result = await confirmPaymentFromProviderStatus({
      payment: basePayment,
      order: { id: 'ord_1', storeId: 'store_1', paymentStatus: 'unpaid', locale: 'ar' },
      providerStatus: statusResponse('completed'),
      source: 'guest_verify',
    });
    expect(result).toEqual({
      paymentStatus: 'paid',
      providerStatus: 'completed',
      statusChanged: false,
    });
    expect(paymentUpdate).not.toHaveBeenCalled();
    expect(recordEvent).not.toHaveBeenCalled();
    expect(inngestSend).not.toHaveBeenCalled();
  });

  it('PAID but the order is no longer confirmable (claim blocked) → stays unpaid, no fanout', async () => {
    claims.paid = 'blocked_status';
    const result = await confirmPaymentFromProviderStatus({
      payment: basePayment,
      order: { id: 'ord_1', storeId: 'store_1', paymentStatus: 'unpaid', locale: null },
      providerStatus: statusResponse('completed'),
      source: 'guest_verify',
    });
    expect(result).toEqual({
      paymentStatus: 'unpaid',
      providerStatus: 'completed',
      statusChanged: false,
    });
    expect(inngestSend).not.toHaveBeenCalled();
  });

  it('FAILED/EXPIRED on an order already PAID (stale snapshot or admin Refresh) → never touches it (M-064)', async () => {
    for (const st of ['failed', 'expired', 'cancelled'] as const) {
      const result = await confirmPaymentFromProviderStatus({
        payment: { ...basePayment, status: 'completed' },
        order: { id: 'ord_1', storeId: 'store_1', paymentStatus: 'paid', locale: null },
        providerStatus: statusResponse(st),
        source: 'admin_refresh',
      });
      expect(result).toEqual({ paymentStatus: 'paid', providerStatus: st, statusChanged: false });
    }
    expect(txn).not.toHaveBeenCalled();
    expect(paymentUpdate).not.toHaveBeenCalled();
  });

  it('FAILED while a concurrent webhook paid the order after our snapshot → claim blocked, order stays paid', async () => {
    claims.failed = 'blocked_paid_or_settled';
    const result = await confirmPaymentFromProviderStatus({
      payment: basePayment,
      order: { id: 'ord_1', storeId: 'store_1', paymentStatus: 'unpaid', locale: null },
      providerStatus: statusResponse('expired'),
      source: 'guest_verify',
    });
    expect(result).toEqual({
      paymentStatus: 'paid',
      providerStatus: 'expired',
      statusChanged: false,
    });
    expect(paymentUpdate).not.toHaveBeenCalled();
    expect(recordEvent).not.toHaveBeenCalled();
  });

  it('PAID + a STALE confirmation on a REFUNDED order → rejected, no status regression', async () => {
    // The current order status is terminal (refunded); a late provider
    // "completed" must NOT flip it back to confirmed. assertValidTransition
    // guards the write. orderFindUnique returns the CURRENT status.
    orderFindUnique.mockResolvedValueOnce({ status: 'refunded' });
    await expect(
      confirmPaymentFromProviderStatus({
        payment: basePayment,
        order: { id: 'ord_1', storeId: 'store_1', paymentStatus: 'unpaid', locale: 'ar' },
        providerStatus: statusResponse('completed'),
        source: 'guest_verify',
      })
    ).rejects.toThrow(/transition|INVALID_STATUS/i);
    // The order-status write transaction never ran.
    expect(txn).not.toHaveBeenCalled();
  });

  it('PAID + order ALREADY paid → idempotent no-op (no write, no double fanout)', async () => {
    const result = await confirmPaymentFromProviderStatus({
      payment: { ...basePayment, status: 'completed' },
      order: { id: 'ord_1', storeId: 'store_1', paymentStatus: 'paid', locale: null },
      providerStatus: statusResponse('completed'),
      source: 'guest_verify',
    });

    expect(result).toEqual({
      paymentStatus: 'paid',
      providerStatus: 'completed',
      statusChanged: false,
    });
    expect(txn).not.toHaveBeenCalled();
    expect(orderUpdate).not.toHaveBeenCalled();
    expect(inngestSend).not.toHaveBeenCalled();
  });

  it('PENDING provider status → no change, never flips to paid', async () => {
    const result = await confirmPaymentFromProviderStatus({
      payment: basePayment,
      order: { id: 'ord_1', storeId: 'store_1', paymentStatus: 'unpaid', locale: null },
      providerStatus: statusResponse('pending'),
      source: 'guest_verify',
    });

    expect(result.paymentStatus).toBe('unpaid');
    expect(result.statusChanged).toBe(false);
    expect(txn).not.toHaveBeenCalled();
    expect(inngestSend).not.toHaveBeenCalled();
  });

  it('FAILED provider status → marks order failed, no fanout', async () => {
    const result = await confirmPaymentFromProviderStatus({
      payment: basePayment,
      order: { id: 'ord_1', storeId: 'store_1', paymentStatus: 'unpaid', locale: null },
      providerStatus: statusResponse('failed'),
      source: 'guest_verify',
    });

    expect(result).toEqual({
      paymentStatus: 'failed',
      providerStatus: 'failed',
      statusChanged: true,
    });
    expect(txn).toHaveBeenCalledTimes(1);
    expect(recordEvent).toHaveBeenCalledTimes(1);
    expect(inngestSend).not.toHaveBeenCalled();
  });

  it('FAILED + order already failed → idempotent no-op', async () => {
    const result = await confirmPaymentFromProviderStatus({
      payment: { ...basePayment, status: 'failed' },
      order: { id: 'ord_1', storeId: 'store_1', paymentStatus: 'failed', locale: null },
      providerStatus: statusResponse('expired'),
      source: 'guest_verify',
    });

    expect(result.statusChanged).toBe(false);
    expect(txn).not.toHaveBeenCalled();
    expect(inngestSend).not.toHaveBeenCalled();
  });

  it('admin_refresh source records an admin_action event (not reconciliation)', async () => {
    await confirmPaymentFromProviderStatus({
      payment: basePayment,
      order: { id: 'ord_1', storeId: 'store_1', paymentStatus: 'unpaid', locale: null },
      providerStatus: statusResponse('completed'),
      source: 'admin_refresh',
      triggeredByUserId: 'user_9',
    });

    expect(recordEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'admin_action',
        triggeredByUserId: 'user_9',
        toStatus: 'completed',
      })
    );
  });

  it('guest_verify source records a reconciliation event with the source tag', async () => {
    await confirmPaymentFromProviderStatus({
      payment: basePayment,
      order: { id: 'ord_1', storeId: 'store_1', paymentStatus: 'unpaid', locale: null },
      providerStatus: statusResponse('completed'),
      source: 'guest_verify',
    });

    expect(recordEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'reconciliation',
        details: expect.objectContaining({ source: 'guest_verify' }),
      })
    );
  });

  // Money-integrity audit F3 (2026-07-02): a 'completed' provider status
  // alone must never be enough to confirm an order — the PAID AMOUNT must
  // also match what we expect (payment.amount, piastres).
  describe('paid-amount reconciliation (F3)', () => {
    it('paidAmount far below payment.amount → does NOT mark paid, alerts P0, no fanout', async () => {
      const result = await confirmPaymentFromProviderStatus({
        payment: basePayment, // amount: 5000 piastres
        order: { id: 'ord_1', storeId: 'store_1', paymentStatus: 'unpaid', locale: null },
        // Provider reports only 1000 piastres paid against a 5000 piastres invoice.
        providerStatus: statusResponse('completed', { paidAmount: 1000, paidCurrency: 'EGP' }),
        source: 'guest_verify',
      });

      expect(result).toEqual({
        paymentStatus: 'unpaid',
        providerStatus: 'completed',
        statusChanged: false,
      });
      // Never transitions the order/payment rows.
      expect(txn).not.toHaveBeenCalled();
      expect(orderUpdate).not.toHaveBeenCalled();
      expect(inngestSend).not.toHaveBeenCalled();
      // Records the mismatch for audit + raises a P0 alert.
      expect(recordEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          eventType: 'reconciliation',
          details: expect.objectContaining({
            reason: 'paid_amount_mismatch',
            expectedFils: 5000,
            paidAmountFils: 1000,
          }),
        })
      );
      expect(sendAlertMock).toHaveBeenCalledWith(
        expect.objectContaining({ level: 'p0', source: 'payment.confirm.amount_mismatch' })
      );
    });

    it('paidAmount within rounding tolerance (≤5 piastres short) → still marks paid', async () => {
      const result = await confirmPaymentFromProviderStatus({
        payment: basePayment, // amount: 5000 piastres
        order: { id: 'ord_1', storeId: 'store_1', paymentStatus: 'unpaid', locale: null },
        providerStatus: statusResponse('completed', { paidAmount: 4997, paidCurrency: 'EGP' }),
        source: 'guest_verify',
      });

      expect(result.statusChanged).toBe(true);
      expect(result.paymentStatus).toBe('paid');
      expect(txn).toHaveBeenCalledTimes(1);
      expect(sendAlertMock).not.toHaveBeenCalled();
    });

    it('no paidAmount reported (a gateway that does not report it leaves it unset) → falls back to status-only, marks paid', async () => {
      const result = await confirmPaymentFromProviderStatus({
        payment: basePayment,
        order: { id: 'ord_1', storeId: 'store_1', paymentStatus: 'unpaid', locale: null },
        providerStatus: statusResponse('completed'), // no paidAmount override
        source: 'guest_verify',
      });

      expect(result.statusChanged).toBe(true);
      expect(result.paymentStatus).toBe('paid');
      expect(sendAlertMock).not.toHaveBeenCalled();
    });

    it('paidAmount OVER expected (overpayment) → still marks paid (only underpayment blocks)', async () => {
      const result = await confirmPaymentFromProviderStatus({
        payment: basePayment,
        order: { id: 'ord_1', storeId: 'store_1', paymentStatus: 'unpaid', locale: null },
        providerStatus: statusResponse('completed', { paidAmount: 6000, paidCurrency: 'EGP' }),
        source: 'guest_verify',
      });

      expect(result.statusChanged).toBe(true);
      expect(result.paymentStatus).toBe('paid');
      expect(sendAlertMock).not.toHaveBeenCalled();
    });
  });
});
