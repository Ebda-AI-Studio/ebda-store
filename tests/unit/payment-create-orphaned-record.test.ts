/**
 * Issue 2370 — the gateway ACCEPTED, then writing the Payment row failed.
 *
 * `PaymentService.createPayment` calls the gateway first and writes the
 * Payment row second. Both callers arm their orphaned-invoice alert only
 * after `createPayment` RESOLVES, so a throw from `prisma.payment.create`
 * (statement timeout, connection blip, the tenant transaction's timeout
 * expiring during the gateway call) left a live invoice with no Payment row
 * and raised nothing. The alert is now raised inside `createPayment`, for
 * every caller.
 *
 * Mutation-proof: deleting the `alertOrphanedProviderInvoice` call in
 * `createPayment`'s catch reddens the "accepted, write throws" case; a catch
 * that swallows instead of rethrowing reddens the `rejects` assertion.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  paymentCreate: vi.fn(),
  paymentConfigFindMany: vi.fn(),
  providerCreatePayment: vi.fn(),
  orphanAlert: vi.fn(async () => undefined),
  recordPaymentEvent: vi.fn(async () => undefined),
}));

vi.mock('@force/database', () => ({
  prisma: {
    payment: {
      create: (...a: unknown[]) => h.paymentCreate(...a),
      count: async () => 0,
    },
    paymentConfig: { findMany: (...a: unknown[]) => h.paymentConfigFindMany(...a) },
    providerActivationRequest: { findMany: async () => [] },
  },
  Prisma: {},
  runInTenantContext: (_s: unknown, fn: () => Promise<unknown>) => fn(),
  withStore: (_s: unknown, fn: () => Promise<unknown>) => fn(),
}));
vi.mock('@api/config', () => ({ config: { paymentTestMode: true } }));
vi.mock('@api/services/encryption.service', () => ({
  encryption: { decrypt: (v: string) => v, encrypt: (v: string) => v },
}));
vi.mock('@api/services/order.service', () => ({
  OrderService: {},
  assertValidTransition: () => undefined,
}));
vi.mock('@api/services/socket.service', () => ({ socketService: {} }));
vi.mock('@api/lib/inngest/client', () => ({ inngest: { send: vi.fn() } }));
vi.mock('@api/services/onesignal.service', () => ({ OneSignalService: {} }));
vi.mock('@api/services/redis.service', () => ({ redis: {} }));
vi.mock('@api/services/alerts.service', () => ({ sendAlert: vi.fn() }));
vi.mock('@api/services/payment-event.service', () => ({
  recordPaymentEvent: (...a: unknown[]) => h.recordPaymentEvent(...(a as [])),
}));
vi.mock('@api/lib/public-cache', () => ({ invalidateCustomersCache: vi.fn() }));
vi.mock('@api/lib/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('@api/services/payment-providers/orphaned-invoice-alert', () => ({
  alertOrphanedProviderInvoice: (...a: unknown[]) => h.orphanAlert(...(a as [])),
}));
// The Egyptian gateways are v2 adapters behind `V2ProviderBridge`; this test drives the v1 face the
// factory uses, so the bridge is replaced by a stub provider named after the adapter it wraps.
vi.mock('@api/services/payment-providers/v2-bridge', () => ({
  V2ProviderBridge: class {
    name: string;
    constructor(adapter: { name: string }) {
      this.name = adapter.name;
    }
    initialize = () => undefined;
    createPayment = (...a: unknown[]) => h.providerCreatePayment(...a);
  },
}));

import { PaymentService } from '@api/services/payment-providers/payment.factory';
import type { CreatePaymentRequest } from '@api/services/payment-providers/types';

const STORE_ID = 'store-2370';
const request: CreatePaymentRequest = {
  orderId: 'order-1',
  orderNumber: 'ORD-2370',
  amount: 5000,
  currency: 'EGP',
  customer: { id: 'c1', name: 'Customer', email: '' },
  items: [{ name: 'Item', quantity: 1, unitPrice: 5000 }],
  callbackUrl: 'https://store.test/checkout/success',
  webhookUrl: 'https://api.test/api/v1/webhooks/payment/paymob',
};

beforeEach(() => {
  vi.clearAllMocks();
  PaymentService.clearCache(STORE_ID);
  h.paymentConfigFindMany.mockResolvedValue([
    {
      provider: 'paymob',
      apiKey: 'k',
      secretKey: null,
      merchantId: null,
      webhookSecret: null,
      testMode: true,
      isEnabled: true,
      isDefault: true,
      displayName: null,
      displayNameAr: null,
      supportedMethods: ['card'],
      supportedCurrencies: ['EGP'],
      fixedFee: 0,
      percentageFee: 0,
    },
  ]);
  h.providerCreatePayment.mockResolvedValue({
    success: true,
    provider: 'paymob',
    transactionId: 'txn-2370',
    invoiceId: 'inv-1',
    paymentUrl: 'https://pay.test/inv-1',
  });
  h.paymentCreate.mockResolvedValue({
    id: 'pay-1',
    orderId: 'order-1',
    order: { storeId: STORE_ID },
  });
});

describe('PaymentService.createPayment — orphaned invoice on a failed record write (issue 2370)', () => {
  it('gateway accepted, payment.create throws → the live invoice is alerted and the error propagates', async () => {
    h.paymentCreate.mockRejectedValueOnce(
      new Error('canceling statement due to statement timeout')
    );

    await expect(PaymentService.createPayment(request, 'paymob', STORE_ID)).rejects.toThrow(
      'statement timeout'
    );

    expect(h.orphanAlert).toHaveBeenCalledTimes(1);
    expect(h.orphanAlert).toHaveBeenCalledWith({
      storeId: STORE_ID,
      orderId: 'order-1',
      orderNumber: 'ORD-2370',
      provider: 'paymob',
      transactionId: 'txn-2370',
      amount: 5000,
      currency: 'EGP',
      source: 'record',
    });
  });

  it('gateway rejected → no alert (nothing was minted)', async () => {
    h.providerCreatePayment.mockRejectedValueOnce(new Error('gateway 400'));

    await expect(PaymentService.createPayment(request, 'paymob', STORE_ID)).rejects.toThrow(
      'gateway 400'
    );

    expect(h.paymentCreate).not.toHaveBeenCalled();
    expect(h.orphanAlert).not.toHaveBeenCalled();
  });

  it('gateway accepted, row written → no alert (control)', async () => {
    const res = await PaymentService.createPayment(request, 'paymob', STORE_ID);

    expect(res.transactionId).toBe('txn-2370');
    expect(h.paymentCreate).toHaveBeenCalledTimes(1);
    expect(h.recordPaymentEvent).toHaveBeenCalledWith(
      expect.objectContaining({ paymentId: 'pay-1', storeId: STORE_ID, eventType: 'created' })
    );
    expect(h.orphanAlert).not.toHaveBeenCalled();
  });
});
