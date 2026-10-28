/**
 * INBOUND payment webhooks keep their money-integrity checks (security review 2026-10-21, after the
 * merchant OUTGOING webhooks work briefly overwrote routes/webhook.routes.ts).
 *
 * Each case goes red if the check in payment.factory.ts / webhook.routes.ts is removed:
 *   1. a webhook whose signature does not verify is rejected before any payment is read or written;
 *   2. a "completed" webhook that reports LESS than the order total never marks the order paid and
 *      raises the P0 amount-mismatch alert.
 * Replay protection is the route's idempotency inbox (the factory write is itself idempotent); the
 * route-level checks (missing signature, duplicate delivery) are in
 * tests/unit/inbound-payment-webhook-routes.test.ts; the per-gateway HMAC contracts in
 * paymob-/kashier-/fawry-official-contract.test.ts and egypt-gateway-adapters.test.ts.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mocks (declared before the module-under-test import) ────────────────

const paymentFindFirst = vi.fn();
const paymentUpdateMany = vi.fn();
const paymentUpdate = vi.fn().mockResolvedValue({});
const orderUpdate = vi.fn().mockResolvedValue({});
const orderFindUnique = vi.fn().mockResolvedValue({ storeId: 'store_1' });
const paymentConfigFindMany = vi.fn();
let paymentFindManyOverride: ((...a: unknown[]) => Promise<unknown[]>) | null = null;
const txMock = vi.fn((ops: unknown[]) => Promise.all(ops));

vi.mock('@ebda/database', () => ({
  currentStoreId: () => STORE_ID,
  prisma: {
    payment: {
      findFirst: (...a: unknown[]) => paymentFindFirst(...a),
      // handleWebhook resolves the payment with findMany({ take: 2 }) so an
      // ambiguous id is refused (issue 769). Tests that want a collision set
      // paymentFindManyOverride; otherwise it mirrors paymentFindFirst.
      findMany: async (...a: unknown[]) => {
        if (paymentFindManyOverride) return paymentFindManyOverride(...a);
        const r = await paymentFindFirst(...a);
        return r ? [r] : [];
      },
      updateMany: (...a: unknown[]) => paymentUpdateMany(...a),
      update: (...a: unknown[]) => paymentUpdate(...a),
      findUnique: vi.fn().mockResolvedValue({ metadata: {} }),
    },
    order: {
      update: (...a: unknown[]) => orderUpdate(...a),
      findUnique: (...a: unknown[]) => orderFindUnique(...a),
    },
    store: { findUnique: vi.fn() },
    providerActivationRequest: { findMany: async () => [] },
    paymentConfig: {
      findMany: (...a: unknown[]) => paymentConfigFindMany(...a),
    },
    $transaction: (ops: unknown[]) => txMock(ops),
    // PaymentService.refund's ledger rows (claim / completed / released).
    paymentEvent: {
      create: vi.fn().mockResolvedValue({}),
      findMany: vi.fn().mockResolvedValue([]),
    },
  },
  Prisma: {},
  // Each refund record commits on its own transaction; with no database the
  // callback simply runs.
  runInTenantContext: (_storeId: unknown, fn: () => Promise<unknown>) => fn(),
  // The factory reads a store's provider configs inside that store's scope.
  withStore: (_storeId: unknown, fn: () => Promise<unknown>) => fn(),
}));

vi.mock('@api/config', () => ({
  config: { paymentTestMode: true },
}));

vi.mock('@api/services/encryption.service', () => ({
  encryption: { decrypt: (v: string) => v, encrypt: (v: string) => v },
}));

// The guard under test — a plain spy so each test controls whether it
// throws, and can assert the exact (from, to) it was called with.
const assertValidTransitionMock = vi.fn();
const applyRefundEffects = vi.fn().mockResolvedValue(undefined);
const recordRefundOutsideReturn = vi.fn();
vi.mock('@api/services/order.service', () => ({
  OrderService: {
    applyRefundEffects: (...a: unknown[]) => applyRefundEffects(...a),
    recordRefundOutsideReturn: (...a: unknown[]) => recordRefundOutsideReturn(...a),
  },
  assertValidTransition: (...a: unknown[]) => assertValidTransitionMock(...a),
}));

vi.mock('@api/services/socket.service', () => ({
  socketService: { emitToStore: vi.fn(), emitToUser: vi.fn() },
}));

vi.mock('@api/lib/inngest/client', () => ({
  inngest: { send: vi.fn().mockResolvedValue(undefined) },
}));

vi.mock('@api/services/onesignal.service', () => ({
  OneSignalService: { sendToStore: vi.fn(), sendToUser: vi.fn() },
}));

vi.mock('@api/services/redis.service', () => ({
  redis: { get: vi.fn(), set: vi.fn(), del: vi.fn(), incrementRateLimit: vi.fn() },
}));

const sendAlertMock = vi.fn().mockResolvedValue(undefined);
vi.mock('@api/services/alerts.service', () => ({
  sendAlert: (...a: unknown[]) => sendAlertMock(...a),
}));

const recordEventMock = vi.fn().mockResolvedValue(undefined);
vi.mock('@api/services/payment-event.service', () => ({
  recordPaymentEvent: (...a: unknown[]) => recordEventMock(...a),
}));

vi.mock('@api/lib/public-cache', () => ({
  invalidateCustomersCache: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@api/lib/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { providerRefund, providerParseWebhook, providerVerify } = vi.hoisted(() => ({
  providerRefund: vi.fn(),
  providerParseWebhook: vi.fn(),
  providerVerify: vi.fn(),
}));

// The Egyptian gateways are v2 adapters behind `V2ProviderBridge`; these tests drive the v1 face
// the factory and PaymentService use, so the bridge itself is replaced by a stub provider.
vi.mock('@api/services/payment-providers/v2-bridge', () => ({
  V2ProviderBridge: class {
    name: string;
    constructor(adapter: { name: string }) {
      this.name = adapter.name;
    }
    initialize = vi.fn();
    refund = providerRefund;
    parseWebhook = providerParseWebhook;
    verifyWebhook = providerVerify;
  },
}));

import { PaymentService } from '@api/services/payment-providers/payment.factory';

const PAYMENT_ID = 'pay_1';
const ORDER_ID = 'order_1';
const STORE_ID = 'store_1';
const TRANSACTION_ID = 'txn_1';

function mockProviderConfig() {
  paymentConfigFindMany.mockResolvedValue([
    {
      provider: 'paymob',
      apiKey: 'test-key',
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
}

function mockPayment(paymentStatus: string, orderStatus = 'pending') {
  paymentFindFirst.mockResolvedValue({
    id: PAYMENT_ID,
    orderId: ORDER_ID,
    amount: 5000,
    currency: 'EGP',
    status: paymentStatus,
    provider: 'paymob',
    metadata: {},
    order: { storeId: STORE_ID, store: { name: 'Test Store' }, status: orderStatus },
  });
}

describe.each(['paymob'] as const)(
  'inbound %s webhook integrity (provider-agnostic factory path)',
  provider => {
    beforeEach(() => {
      vi.clearAllMocks();
      mockProviderConfig();
      paymentConfigFindMany.mockResolvedValue([
        {
          ...(paymentConfigFindMany.getMockImplementation ? {} : {}),
          provider,
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
    });

    it('rejects a bad signature before reading or writing any payment', async () => {
      providerVerify.mockReturnValue(false);
      await expect(
        PaymentService.handleWebhook(provider, { fake: true }, 'forged', STORE_ID)
      ).rejects.toMatchObject({ code: 'INVALID_SIGNATURE' });
      expect(providerParseWebhook).not.toHaveBeenCalled();
      expect(paymentFindFirst).not.toHaveBeenCalled();
      expect(paymentUpdate).not.toHaveBeenCalled();
      expect(paymentUpdateMany).not.toHaveBeenCalled();
      expect(orderUpdate).not.toHaveBeenCalled();
    });

    it('SEC-5: verifyWebhookDelivery (the route pre-check) rejects a forged signature and touches no payment', async () => {
      providerVerify.mockReturnValue(false);
      await expect(
        PaymentService.verifyWebhookDelivery(provider, { fake: true }, 'forged', STORE_ID)
      ).rejects.toMatchObject({ code: 'INVALID_SIGNATURE' });
      await expect(
        PaymentService.verifyWebhookDelivery(provider, { fake: true }, undefined, STORE_ID)
      ).rejects.toMatchObject({ code: 'MISSING_SIGNATURE' });
      expect(paymentFindFirst).not.toHaveBeenCalled();
      expect(paymentUpdate).not.toHaveBeenCalled();
    });

    it('an underpaid "completed" webhook never marks the order paid and raises the p0 alert', async () => {
      providerVerify.mockReturnValue(true);
      mockPayment('pending', 'pending');
      providerParseWebhook.mockReturnValue({
        transactionId: TRANSACTION_ID,
        status: 'completed',
        amount: 4000,
        currency: 'EGP',
      });
      await PaymentService.handleWebhook(provider, { fake: true }, 'sig', STORE_ID);
      expect(orderUpdate).not.toHaveBeenCalled();
      // The mismatch is RECORDED on the payment; its status is not advanced.
      for (const [arg] of paymentUpdate.mock.calls) {
        expect((arg as { data: Record<string, unknown> }).data.status).toBeUndefined();
        expect(
          (arg as { data: { metadata?: { amountMismatch?: boolean } } }).data.metadata
            ?.amountMismatch
        ).toBe(true);
      }
      expect(recordEventMock).toHaveBeenCalledWith(
        expect.objectContaining({
          details: expect.objectContaining({ reason: 'paid_amount_mismatch' }),
        })
      );
      expect(sendAlertMock).toHaveBeenCalledWith(
        expect.objectContaining({ level: 'p0', source: 'payment.webhook.amount_mismatch' })
      );
    });
  }
);
