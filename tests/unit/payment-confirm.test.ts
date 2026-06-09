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
const txn = vi.fn().mockResolvedValue([{}, {}]);
vi.mock('@force/database', () => ({
  prisma: {
    payment: { update: (...a: unknown[]) => paymentUpdate(...a) },
    order: { update: (...a: unknown[]) => orderUpdate(...a) },
    $transaction: (...a: unknown[]) => txn(...a),
  },
}));

// Mock the append-only event log — assert it's written, don't hit a DB.
const recordEvent = vi.fn().mockResolvedValue(undefined);
vi.mock('@api/services/payment-event.service', () => ({
  recordPaymentEvent: (...a: unknown[]) => recordEvent(...a),
}));

import { confirmPaymentFromProviderStatus } from '@api/services/payment-confirm.service';
import type { PaymentStatusResponse } from '@api/services/payment-providers/types';

const basePayment = {
  id: 'pay_1',
  status: 'pending',
  provider: 'myfatoorah',
  metadata: {},
};

function statusResponse(status: PaymentStatusResponse['status']): PaymentStatusResponse {
  return {
    success: true,
    provider: 'myfatoorah',
    transactionId: '215031900',
    invoiceId: '215031900',
    status,
    amount: 5000,
    currency: 'KWD',
  };
}

describe('confirmPaymentFromProviderStatus', () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
        paymentMethod: 'myfatoorah',
        locale: 'ar',
      },
    });
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
});
