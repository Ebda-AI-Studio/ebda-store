/**
 * Direct-writer wiring tests for the state machine guard (money-integrity
 * Task 6). `assertValidTransition`'s own pass/reject logic is covered
 * exhaustively against the real implementation in
 * `tests/unit/order-status-machine.test.ts`; this file instead proves that
 * the 3 payment-gateway/webhook sites in `payment.factory.ts` that write
 * `Order.status` directly (bypassing `OrderService.updateStatus`) actually
 * CALL the guard with the loaded prior status before writing, and that a
 * rejection propagates instead of silently regressing the order:
 *
 *   1. `PaymentService.refund()` — full-refund write (`status: 'refunded'`).
 *   2. `PaymentService.handleWebhook()` — out-of-band refund-webhook write.
 *   3. `PaymentService.handleWebhook()` — general payment-webhook write.
 *
 * `@api/services/order.service` is mocked with a directly-controllable
 * `assertValidTransition` spy (rather than the real implementation) so each
 * test can assert exactly what `(from, to)` pair the call site passes, and
 * simulate a reject without needing to fabricate a specific stale order
 * status combination.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mocks (declared before the module-under-test import) ────────────────

const paymentFindFirst = vi.fn();
const paymentUpdateMany = vi.fn();
const paymentUpdate = vi.fn().mockResolvedValue({});
const orderUpdate = vi.fn().mockResolvedValue({});
const orderFindUnique = vi.fn().mockResolvedValue({ storeId: 'store_1' });
const paymentConfigFindMany = vi.fn();
const txMock = vi.fn((ops: unknown[]) => Promise.all(ops));

vi.mock('@force/database', () => ({
  prisma: {
    payment: {
      findFirst: (...a: unknown[]) => paymentFindFirst(...a),
      updateMany: (...a: unknown[]) => paymentUpdateMany(...a),
      update: (...a: unknown[]) => paymentUpdate(...a),
    },
    order: {
      update: (...a: unknown[]) => orderUpdate(...a),
      findUnique: (...a: unknown[]) => orderFindUnique(...a),
    },
    store: { findUnique: vi.fn() },
    paymentConfig: {
      findMany: (...a: unknown[]) => paymentConfigFindMany(...a),
    },
    $transaction: (ops: unknown[]) => txMock(ops),
  },
  Prisma: {},
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
vi.mock('@api/services/order.service', () => ({
  OrderService: { applyRefundEffects: (...a: unknown[]) => applyRefundEffects(...a) },
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

vi.mock('@api/services/alerts.service', () => ({
  sendAlert: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@api/services/payment-event.service', () => ({
  recordPaymentEvent: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@api/lib/public-cache', () => ({
  invalidateCustomersCache: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@api/lib/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { providerRefund, providerParseWebhook } = vi.hoisted(() => ({
  providerRefund: vi.fn(),
  providerParseWebhook: vi.fn(),
}));
vi.mock('@api/services/payment-providers/tap.provider', () => ({
  TapPaymentProvider: class {
    initialize = vi.fn();
    refund = providerRefund;
    parseWebhook = providerParseWebhook;
    verifyWebhook = vi.fn().mockReturnValue(true);
  },
}));
vi.mock('@api/services/payment-providers/myfatoorah.provider', () => ({
  MyFatoorahPaymentProvider: class {
    initialize = vi.fn();
    refund = providerRefund;
    parseWebhook = providerParseWebhook;
    verifyWebhook = vi.fn().mockReturnValue(true);
  },
}));
vi.mock('@api/services/payment-providers/hesabe.provider', () => ({
  HesabePaymentProvider: class {
    initialize = vi.fn();
    refund = providerRefund;
    parseWebhook = providerParseWebhook;
    verifyWebhook = vi.fn().mockReturnValue(true);
  },
}));
vi.mock('@api/services/payment-providers/upayments.provider', () => ({
  UPaymentsProvider: class {
    initialize = vi.fn();
    refund = providerRefund;
    parseWebhook = providerParseWebhook;
    verifyWebhook = vi.fn().mockReturnValue(true);
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
      provider: 'myfatoorah',
      apiKey: 'test-key',
      secretKey: null,
      merchantId: null,
      webhookSecret: null,
      testMode: true,
      isEnabled: true,
      isDefault: true,
      displayName: null,
      displayNameAr: null,
      supportedMethods: ['knet'],
      supportedCurrencies: ['KWD'],
      fixedFee: 0,
      percentageFee: 0,
    },
  ]);
}

describe('PaymentService.refund — state machine guard (site 1/3)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockProviderConfig();
  });

  function mockPayment(orderStatus: string) {
    paymentFindFirst.mockResolvedValue({
      id: PAYMENT_ID,
      orderId: ORDER_ID,
      amount: 5000,
      status: 'completed',
      provider: 'myfatoorah',
      metadata: {},
      order: { storeId: STORE_ID, store: {}, status: orderStatus },
    });
  }

  it('calls assertValidTransition(priorStatus, "refunded") BEFORE claiming the payment or calling the provider', async () => {
    mockPayment('confirmed');
    assertValidTransitionMock.mockImplementation(() => undefined);
    paymentUpdateMany.mockResolvedValue({ count: 1 });
    providerRefund.mockResolvedValue({
      success: true,
      provider: 'myfatoorah',
      refundId: 'rf_1',
      transactionId: TRANSACTION_ID,
      amount: 5000,
      status: 'completed',
    });
    txMock.mockResolvedValue([{}, {}]);

    await PaymentService.refund({ transactionId: TRANSACTION_ID });

    expect(assertValidTransitionMock).toHaveBeenCalledWith('confirmed', 'refunded');
    // The guard ran before the provider was ever touched (called order matters).
    const guardCallOrder = assertValidTransitionMock.mock.invocationCallOrder[0];
    const providerCallOrder = providerRefund.mock.invocationCallOrder[0];
    expect(guardCallOrder).toBeLessThan(providerCallOrder);
  });

  it('rejects (and never calls the provider) when assertValidTransition throws for a stale order state', async () => {
    mockPayment('cancelled');
    assertValidTransitionMock.mockImplementation(() => {
      throw new Error('Cannot transition from cancelled to refunded');
    });

    await expect(PaymentService.refund({ transactionId: TRANSACTION_ID })).rejects.toThrow(
      'Cannot transition from cancelled to refunded'
    );

    expect(providerRefund).not.toHaveBeenCalled();
    expect(paymentUpdateMany).not.toHaveBeenCalled();
  });
});

describe('PaymentService.handleWebhook — state machine guard (sites 2/3 & 3/3)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockProviderConfig();
  });

  function mockPaymentForWebhook(orderStatus: string, paymentStatus = 'completed') {
    paymentFindFirst.mockResolvedValue({
      id: PAYMENT_ID,
      orderId: ORDER_ID,
      amount: 5000,
      currency: 'KWD',
      status: paymentStatus,
      provider: 'myfatoorah',
      metadata: {},
      order: { storeId: STORE_ID, store: { name: 'Test Store' }, status: orderStatus },
    });
  }

  it('out-of-band refund webhook: calls assertValidTransition(priorStatus, "refunded") before applyRefundEffects, and rejects on a stale order state', async () => {
    mockPaymentForWebhook('cancelled', 'completed');
    providerParseWebhook.mockReturnValue({
      transactionId: TRANSACTION_ID,
      status: 'completed',
      refund: { status: 'completed', refundId: 'rf_2' },
    });
    assertValidTransitionMock.mockImplementation(() => {
      throw new Error('Cannot transition from cancelled to refunded');
    });

    await expect(
      PaymentService.handleWebhook('myfatoorah', { fake: true }, undefined, STORE_ID)
    ).rejects.toThrow('Cannot transition from cancelled to refunded');

    expect(assertValidTransitionMock).toHaveBeenCalledWith('cancelled', 'refunded');
    // applyRefundEffects must NOT have run — the guard is checked first so a
    // rejected transition never runs reversal side-effects it can't commit.
    expect(applyRefundEffects).not.toHaveBeenCalled();
  });

  it('out-of-band refund webhook: valid prior state proceeds to applyRefundEffects + the order write', async () => {
    mockPaymentForWebhook('shipped', 'completed');
    providerParseWebhook.mockReturnValue({
      transactionId: TRANSACTION_ID,
      status: 'completed',
      refund: { status: 'completed', refundId: 'rf_2' },
    });
    assertValidTransitionMock.mockImplementation(() => undefined);

    await PaymentService.handleWebhook('myfatoorah', { fake: true }, undefined, STORE_ID);

    expect(assertValidTransitionMock).toHaveBeenCalledWith('shipped', 'refunded');
    expect(applyRefundEffects).toHaveBeenCalledWith(STORE_ID, ORDER_ID);
  });

  it('general payment webhook: calls assertValidTransition(priorStatus, orderStatus) and rejects a stale "completed" webhook on an already-refunded order', async () => {
    mockPaymentForWebhook('refunded', 'refunded');
    providerParseWebhook.mockReturnValue({
      transactionId: TRANSACTION_ID,
      status: 'completed',
      amount: 5000,
      currency: 'KWD',
      paidAt: new Date(),
    });
    assertValidTransitionMock.mockImplementation(() => {
      throw new Error('Cannot transition from refunded to confirmed');
    });

    await expect(
      PaymentService.handleWebhook('myfatoorah', { fake: true }, undefined, STORE_ID)
    ).rejects.toThrow('Cannot transition from refunded to confirmed');

    expect(assertValidTransitionMock).toHaveBeenCalledWith('refunded', 'confirmed');
    // The order write must never happen once the guard rejects.
    expect(orderUpdate).not.toHaveBeenCalled();
  });

  it('general payment webhook: valid prior state ("pending" → "confirmed" on a completed payment) proceeds to the order write', async () => {
    mockPaymentForWebhook('pending', 'pending');
    providerParseWebhook.mockReturnValue({
      transactionId: TRANSACTION_ID,
      status: 'completed',
      amount: 5000,
      currency: 'KWD',
      paidAt: new Date(),
    });
    assertValidTransitionMock.mockImplementation(() => undefined);

    await PaymentService.handleWebhook('myfatoorah', { fake: true }, undefined, STORE_ID);

    expect(assertValidTransitionMock).toHaveBeenCalledWith('pending', 'confirmed');
    expect(orderUpdate).toHaveBeenCalledWith({
      where: { id: ORDER_ID },
      data: { status: 'confirmed', paymentStatus: 'paid' },
    });
  });
});

// ─── Adversarial audit P2 (Task 9): write ORDERING around the guard ────────
//
// The guard existing is not enough — the ORDER of durable writes matters:
//
//  A. General webhook path: `Payment.status` was written BEFORE the order
//     transition assert, so a stale/raced `completed` webhook on a cancelled
//     order left `Payment.status='completed'` + `Order.status='cancelled'`
//     durably (money captured for a cancelled order, no reconciler for that
//     combination). The payment write must not happen when the order
//     transition is rejected — mirror payment-confirm.service.ts.
//
//  B. Refund webhook branch: the durable idempotency key
//     (`metadata.refundStatus`) was written BEFORE `applyRefundEffects`, so a
//     failed reversal dispatch hit the `prevRefundStatus === newStatus` no-op
//     on retry and the reversal was silently lost forever (07-15 audit F3 —
//     narrowed, not fixed). The idempotency write must come AFTER the
//     effects succeed so a failure stays retryable.

describe('handleWebhook write ordering — payment write vs order-transition assert (audit P2)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockProviderConfig();
  });

  function mockPaymentForWebhook(orderStatus: string, paymentStatus = 'pending') {
    paymentFindFirst.mockResolvedValue({
      id: PAYMENT_ID,
      orderId: ORDER_ID,
      amount: 5000,
      currency: 'KWD',
      status: paymentStatus,
      provider: 'myfatoorah',
      metadata: {},
      order: { storeId: STORE_ID, store: { name: 'Test Store' }, status: orderStatus },
    });
  }

  it('a rejected order transition leaves Payment.status UNWRITTEN (no completed-payment-on-cancelled-order state)', async () => {
    mockPaymentForWebhook('cancelled', 'pending');
    providerParseWebhook.mockReturnValue({
      transactionId: TRANSACTION_ID,
      status: 'completed',
      amount: 5000,
      currency: 'KWD',
      paidAt: new Date(),
    });
    assertValidTransitionMock.mockImplementation(() => {
      throw new Error('Cannot transition from cancelled to confirmed');
    });

    await expect(
      PaymentService.handleWebhook('myfatoorah', { fake: true }, undefined, STORE_ID)
    ).rejects.toThrow('Cannot transition from cancelled to confirmed');

    expect(orderUpdate).not.toHaveBeenCalled();
    // The critical new assertion: the payment row must not have been mutated
    // before the assert rejected.
    expect(paymentUpdate).not.toHaveBeenCalled();
  });

  it('refund branch: a failed applyRefundEffects leaves the idempotency metadata UNWRITTEN (retryable, not silently lost)', async () => {
    mockPaymentForWebhook('shipped', 'completed');
    providerParseWebhook.mockReturnValue({
      transactionId: TRANSACTION_ID,
      status: 'completed',
      refund: { status: 'completed', refundId: 'rf_9' },
    });
    assertValidTransitionMock.mockImplementation(() => undefined);
    applyRefundEffects.mockRejectedValueOnce(new Error('inngest event API down'));

    await expect(
      PaymentService.handleWebhook('myfatoorah', { fake: true }, undefined, STORE_ID)
    ).rejects.toThrow('inngest event API down');

    // metadata.refundStatus (the branch's idempotency key) must NOT be
    // durable — a retry must re-enter the reversal, not hit the no-op.
    expect(paymentUpdate).not.toHaveBeenCalled();
  });

  it('refund branch: a failed order flip PROPAGATES (retryable) instead of being swallowed', async () => {
    mockPaymentForWebhook('shipped', 'completed');
    providerParseWebhook.mockReturnValue({
      transactionId: TRANSACTION_ID,
      status: 'completed',
      refund: { status: 'completed', refundId: 'rf_10' },
    });
    assertValidTransitionMock.mockImplementation(() => undefined);
    applyRefundEffects.mockResolvedValue(undefined);
    orderUpdate.mockRejectedValueOnce(new Error('connection reset'));

    await expect(
      PaymentService.handleWebhook('myfatoorah', { fake: true }, undefined, STORE_ID)
    ).rejects.toThrow('connection reset');

    expect(paymentUpdate).not.toHaveBeenCalled();
  });

  it('refund branch success: the idempotency metadata write happens AFTER applyRefundEffects', async () => {
    mockPaymentForWebhook('shipped', 'completed');
    providerParseWebhook.mockReturnValue({
      transactionId: TRANSACTION_ID,
      status: 'completed',
      refund: { status: 'completed', refundId: 'rf_11' },
    });
    assertValidTransitionMock.mockImplementation(() => undefined);
    applyRefundEffects.mockResolvedValue(undefined);
    orderUpdate.mockResolvedValue({});

    await PaymentService.handleWebhook('myfatoorah', { fake: true }, undefined, STORE_ID);

    expect(applyRefundEffects).toHaveBeenCalled();
    expect(paymentUpdate).toHaveBeenCalled();
    expect(applyRefundEffects.mock.invocationCallOrder[0]).toBeLessThan(
      paymentUpdate.mock.invocationCallOrder[0]
    );
  });
});
