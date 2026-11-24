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
const paymentEventCreateMock = vi.fn().mockResolvedValue({});
const paymentEventFindManyMock = vi.fn().mockResolvedValue([]);
const paymentUpdateMany = vi.fn();
const paymentUpdate = vi.fn().mockResolvedValue({});
const inngestSend = vi.fn().mockResolvedValue(undefined);
const notifyFailure = vi.fn().mockResolvedValue(undefined);
const orderUpdate = vi.fn().mockResolvedValue({});
// the paid / failed transitions are conditional claims (payment-state-claims): one updateMany each
const orderUpdateMany = vi.fn().mockResolvedValue({ count: 1 });
const orderFindUnique = vi.fn().mockResolvedValue({ storeId: 'store_1' });
const paymentConfigFindMany = vi.fn();
let paymentFindManyOverride: ((...a: unknown[]) => Promise<unknown[]>) | null = null;
const txMock = vi.fn((ops: unknown[]) => Promise.all(ops));

vi.mock('@ebda/database', () => ({
  currentStoreId: () => STORE_ID,
  prisma: {
    $queryRaw: vi.fn().mockResolvedValue([]),
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
      // readPayment (refund-settle) and PaymentService.refund both re-read the payment: serve the current fixture
      findUnique: async () => {
        const r = (await paymentFindFirst()) as Record<string, unknown> | undefined;
        return r ? { ...r, metadata: r.metadata ?? {} } : { metadata: {} };
      },
    },
    order: {
      update: (...a: unknown[]) => orderUpdate(...a),
      updateMany: (...a: unknown[]) => orderUpdateMany(...a),
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
      create: (...a: unknown[]) => paymentEventCreateMock(...a),
      findMany: (...a: unknown[]) => paymentEventFindManyMock(...a),
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
  inngest: { send: (...a: unknown[]) => inngestSend(...a) },
}));

vi.mock('@api/services/onesignal.service', () => ({
  OneSignalService: {
    sendToStore: vi.fn(),
    sendToUser: vi.fn(),
    notifyAdminsOfPaymentFailure: (...a: unknown[]) => notifyFailure(...a),
  },
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
      provider: 'paymob',
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
      provider: 'paymob',
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
      currency: 'EGP',
      status: paymentStatus,
      provider: 'paymob',
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
      PaymentService.handleWebhook('paymob', { fake: true }, 'sig', STORE_ID)
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

    await PaymentService.handleWebhook('paymob', { fake: true }, 'sig', STORE_ID);

    expect(assertValidTransitionMock).toHaveBeenCalledWith('shipped', 'refunded');
    expect(applyRefundEffects).toHaveBeenCalledWith(STORE_ID, ORDER_ID);
  });

  /**
   * Found by scripts/defence-mutation-record.mjs, 2026-09-02: wrapping this
   * call site in `.catch(() => {})` SURVIVED — every existing test passed with
   * the failure swallowed, while the same mutation on the direct refund path
   * was killed by payment-service-refund.test.ts. The comment above the call
   * in payment.factory.ts explains at length why the rejection must propagate
   * (the Inngest step's 3 retries + the alerts-failure-watch P0 dead-letter
   * are the only thing standing between a failed reversal and a WebhookEvent
   * marked 'processed' as if the money had been put back) — but nothing
   * enforced it, so any future refactor could have quietly reinstated the
   * swallow that this code was written to remove.
   */
  it('out-of-band refund webhook: a failing applyRefundEffects propagates and never writes the idempotency metadata', async () => {
    mockPaymentForWebhook('shipped', 'completed');
    providerParseWebhook.mockReturnValue({
      transactionId: TRANSACTION_ID,
      status: 'completed',
      refund: { status: 'completed', refundId: 'rf_3' },
    });
    assertValidTransitionMock.mockImplementation(() => undefined);
    applyRefundEffects.mockRejectedValueOnce(new Error('GL reversal failed'));

    await expect(
      PaymentService.handleWebhook('paymob', { fake: true }, 'sig', STORE_ID)
    ).rejects.toThrow('GL reversal failed');

    // The order flip and the durable idempotency write both sit AFTER the
    // reversal. Neither may run, or the Inngest retry would skip the branch
    // and the reversal would be lost for good.
    expect(orderUpdate).not.toHaveBeenCalled();
    expect(paymentUpdate).not.toHaveBeenCalled();
  });

  it('general payment webhook: calls assertValidTransition(priorStatus, orderStatus) and rejects a stale "completed" webhook on an already-refunded order', async () => {
    mockPaymentForWebhook('refunded', 'refunded');
    providerParseWebhook.mockReturnValue({
      transactionId: TRANSACTION_ID,
      status: 'completed',
      amount: 5000,
      currency: 'EGP',
      paidAt: new Date(),
    });
    assertValidTransitionMock.mockImplementation(() => {
      throw new Error('Cannot transition from refunded to confirmed');
    });

    await expect(
      PaymentService.handleWebhook('paymob', { fake: true }, 'sig', STORE_ID)
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
      currency: 'EGP',
      paidAt: new Date(),
    });
    assertValidTransitionMock.mockImplementation(() => undefined);

    await PaymentService.handleWebhook('paymob', { fake: true }, 'sig', STORE_ID);

    expect(assertValidTransitionMock).toHaveBeenCalledWith('pending', 'confirmed');
    expect(orderUpdateMany).toHaveBeenCalledWith({
      where: expect.objectContaining({
        id: ORDER_ID,
        storeId: STORE_ID,
        paymentStatus: { in: ['unpaid', 'failed'] },
      }),
      data: { status: 'confirmed', paymentStatus: 'paid' },
    });
  });

  it('a verify that already paid the order: the webhook claims nothing, so no second fan-out (M-049)', async () => {
    mockPaymentForWebhook('confirmed', 'completed');
    providerParseWebhook.mockReturnValue({
      transactionId: TRANSACTION_ID,
      status: 'completed',
      amount: 5000,
      currency: 'EGP',
      paidAt: new Date(),
    });
    assertValidTransitionMock.mockImplementation(() => undefined);
    // both claim shapes (confirming, then already-fulfilled) match nothing: it is already paid
    orderUpdateMany.mockResolvedValueOnce({ count: 0 }).mockResolvedValueOnce({ count: 0 });
    orderFindUnique.mockResolvedValueOnce({ paymentStatus: 'paid' });

    await PaymentService.handleWebhook('paymob', { fake: true }, 'sig', STORE_ID);

    expect(inngestSend).not.toHaveBeenCalled();
  });

  it('a late or replayed webhook never moves a captured / refunded payment row off its state (payment write guard)', async () => {
    for (const [incoming, notIn] of [
      ['pending', ['completed', 'refunded', 'partially_refunded', 'disputed']],
      ['processing', ['completed', 'refunded', 'partially_refunded', 'disputed']],
      ['completed', ['refunded', 'partially_refunded', 'disputed']],
    ] as const) {
      vi.clearAllMocks();
      mockPaymentForWebhook('confirmed', 'completed');
      providerParseWebhook.mockReturnValue({
        transactionId: TRANSACTION_ID,
        status: incoming,
        amount: 5000,
        currency: 'EGP',
      });
      assertValidTransitionMock.mockImplementation(() => undefined);
      paymentUpdateMany.mockResolvedValue({ count: 0 });
      orderUpdateMany.mockResolvedValue({ count: 0 });
      orderFindUnique.mockResolvedValue({ paymentStatus: 'paid' });
      await PaymentService.handleWebhook('paymob', { fake: true }, 'sig', STORE_ID);
      const write = paymentUpdateMany.mock.calls.find(
        c => (c[0] as { data?: { status?: string } }).data?.status === incoming
      );
      expect(write, `payment write for ${incoming}`).toBeTruthy();
      expect((write![0] as { where: { status?: unknown } }).where.status).toEqual({ notIn });
    }
  });

  it('a late FAILED webhook on a PAID order changes nothing and pushes no failure alert (M-064)', async () => {
    mockPaymentForWebhook('confirmed', 'completed');
    providerParseWebhook.mockReturnValue({
      transactionId: TRANSACTION_ID,
      status: 'expired',
      amount: 5000,
      currency: 'EGP',
    });
    assertValidTransitionMock.mockImplementation(() => undefined);
    orderUpdateMany.mockResolvedValueOnce({ count: 0 });
    orderFindUnique.mockResolvedValueOnce({ paymentStatus: 'paid' });

    await PaymentService.handleWebhook('paymob', { fake: true }, 'sig', STORE_ID);

    // the payment row is only touched through a guard that excludes a completed payment
    const writes = paymentUpdateMany.mock.calls.filter(
      c => (c[0] as { data?: { status?: string } }).data?.status === 'expired'
    );
    for (const w of writes)
      expect((w[0] as { where: { status?: unknown } }).where.status).toEqual({
        notIn: ['completed', 'refunded', 'partially_refunded', 'disputed'],
      });
    expect(notifyFailure).not.toHaveBeenCalled();
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
      currency: 'EGP',
      status: paymentStatus,
      provider: 'paymob',
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
      currency: 'EGP',
      paidAt: new Date(),
    });
    assertValidTransitionMock.mockImplementation(() => {
      throw new Error('Cannot transition from cancelled to confirmed');
    });

    await expect(
      PaymentService.handleWebhook('paymob', { fake: true }, 'sig', STORE_ID)
    ).rejects.toThrow('Cannot transition from cancelled to confirmed');

    expect(orderUpdate).not.toHaveBeenCalled();
    expect(orderUpdateMany).not.toHaveBeenCalled();
    // The critical new assertion: the payment row must not have been mutated
    // before the assert rejected.
    expect(paymentUpdate).not.toHaveBeenCalled();
    expect(
      paymentUpdateMany.mock.calls.some(c => (c[0] as { data?: { status?: string } }).data?.status)
    ).toBe(false);
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
      PaymentService.handleWebhook('paymob', { fake: true }, 'sig', STORE_ID)
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
      PaymentService.handleWebhook('paymob', { fake: true }, 'sig', STORE_ID)
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

    await PaymentService.handleWebhook('paymob', { fake: true }, 'sig', STORE_ID);

    expect(applyRefundEffects).toHaveBeenCalled();
    expect(paymentUpdate).toHaveBeenCalled();
    expect(applyRefundEffects.mock.invocationCallOrder[0]).toBeLessThan(
      paymentUpdate.mock.invocationCallOrder[0]
    );
  });
});

describe('refund webhook — refundedAmount is a cumulative budget, not a scratch field', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockProviderConfig();
  });

  /**
   * `Payment.refundedAmount` is the running total PaymentService.refund
   * compare-and-swaps against to compute the remaining refundable balance, and
   * `Payment.status` decides whether ReturnService will accept the payment as a
   * refund source at all.
   *
   * This branch used to write both absolutely: refundedAmount set to THIS
   * refund's amount — the provider reports one refund, never a running total —
   * and status forced to 'refunded'. On a partially-refunded payment that
   * erased every earlier refund from the budget and marked the whole payment
   * settled, so the next partial return was rejected for having no refundable
   * payment while the balance was recomputed against a too-small total.
   */
  function paymentWith(refundedAmount: number, status: string) {
    paymentFindFirst.mockResolvedValue({
      id: PAYMENT_ID,
      orderId: ORDER_ID,
      amount: 5000,
      currency: 'EGP',
      status,
      refundedAmount,
      provider: 'paymob',
      metadata: {},
      order: { storeId: STORE_ID, store: { name: 'Test Store' }, status: 'shipped' },
    });
    providerParseWebhook.mockReturnValue({
      transactionId: TRANSACTION_ID,
      status: 'completed',
      refund: { status: 'completed', refundId: 'rf_c', amount: 2000 },
    });
    assertValidTransitionMock.mockImplementation(() => undefined);
    applyRefundEffects.mockResolvedValue(undefined);
  }

  /** The data written by the payment.update that carries the refund fields. */
  function refundWrite() {
    return paymentUpdate.mock.calls
      .map(c => (c[0] as { data: Record<string, unknown> }).data)
      .find(d => 'refundedAmount' in d);
  }

  it('the refund that SETTLES a partially-refunded payment still reverses the order', async () => {
    // The gate used to ask whether the PAYMENT had been handled. A payment
    // reading `partially_refunded` counted as handled, so the refund that
    // finally exhausted it was written as terminal with every effect
    // suppressed: the customer had all their money back while the order sat
    // delivered, inventory unrestored and the sale journal still booked.
    paymentFindFirst.mockResolvedValue({
      id: PAYMENT_ID,
      orderId: ORDER_ID,
      amount: 9400,
      currency: 'EGP',
      status: 'partially_refunded',
      refundedAmount: 5000,
      provider: 'paymob',
      // The first portal refund is on record, so this second one is new.
      metadata: { refundEventIds: ['rf_a'], refundStatusById: { rf_a: 'completed' } },
      order: { storeId: STORE_ID, store: { name: 'Test Store' }, status: 'delivered' },
    });
    providerParseWebhook.mockReturnValue({
      transactionId: TRANSACTION_ID,
      status: 'completed',
      refund: { status: 'completed', refundId: 'rf_b', amount: 4400 },
    });
    assertValidTransitionMock.mockImplementation(() => undefined);
    applyRefundEffects.mockResolvedValue(undefined);

    await PaymentService.handleWebhook('paymob', { fake: true }, 'sig', STORE_ID);

    expect(refundWrite()?.status, 'the payment is settled').toBe('refunded');
    expect(
      applyRefundEffects,
      'a settled payment whose order was never reversed must reverse it'
    ).toHaveBeenCalledWith(STORE_ID, ORDER_ID);
    expect(orderUpdate, 'and the order must leave delivered').toHaveBeenCalled();
  });

  it('does not reverse an order a previous refund already reversed', async () => {
    paymentFindFirst.mockResolvedValue({
      id: PAYMENT_ID,
      orderId: ORDER_ID,
      amount: 9400,
      currency: 'EGP',
      status: 'refunded',
      refundedAmount: 9400,
      provider: 'paymob',
      metadata: { refundEventIds: ['rf_a'], refundStatusById: { rf_a: 'completed' } },
      order: { storeId: STORE_ID, store: { name: 'Test Store' }, status: 'refunded' },
    });
    providerParseWebhook.mockReturnValue({
      transactionId: TRANSACTION_ID,
      status: 'completed',
      refund: { status: 'completed', refundId: 'rf_b', amount: 100 },
    });
    assertValidTransitionMock.mockImplementation(() => undefined);

    await PaymentService.handleWebhook('paymob', { fake: true }, 'sig', STORE_ID);

    expect(applyRefundEffects, 'the order is already reversed').not.toHaveBeenCalled();
  });

  it('never lowers the running total when the refund was already accounted', async () => {
    // 3000 already refunded in-band; this webhook reports its own 2000 slice.
    paymentWith(3000, 'partially_refunded');

    await PaymentService.handleWebhook('paymob', { fake: true }, 'sig', STORE_ID);

    const w = refundWrite();
    expect(w?.refundedAmount, 'writing 2000 here would erase 1000 of real refunds').toBe(3000);
  });

  it('does not force a terminal status while a balance remains', async () => {
    paymentWith(3000, 'partially_refunded');

    await PaymentService.handleWebhook('paymob', { fake: true }, 'sig', STORE_ID);

    // 3000 of 5000 refunded — still partially refunded, so ReturnService can
    // still accept it for the remaining 2000.
    expect(refundWrite()?.status).toBe('partially_refunded');
  });

  it('raises the total for an OUT-OF-BAND refund the system never accounted', async () => {
    // Taken in the provider dashboard: nothing incremented refundedAmount, so
    // this webhook is the first evidence of it.
    paymentWith(0, 'completed');

    await PaymentService.handleWebhook('paymob', { fake: true }, 'sig', STORE_ID);

    expect(refundWrite()?.refundedAmount).toBe(2000);
    expect(refundWrite()?.status).toBe('partially_refunded');

    // ...and it must NOT run the whole-order reversal. This case drove exactly
    // this state and asserted only the write, so the suite ratified the defect:
    // a 2000-of-5000 refund taken in the provider's portal restored inventory
    // for every line the customer still holds, reversed the entire sale journal
    // and COGS, decremented coupon usage, clawed back affiliate commission and
    // stripped loyalty — then flipped the order to 'refunded' while the payment
    // row said 'partially_refunded'.
    expect(
      applyRefundEffects,
      'a partial out-of-band refund must not trigger whole-order effects'
    ).not.toHaveBeenCalled();
    expect(orderUpdate, 'nor flip the order to a terminal state').not.toHaveBeenCalled();
  });

  it('DOES run the whole-order reversal when the out-of-band refund settles the payment', async () => {
    paymentWith(0, 'completed');
    providerParseWebhook.mockReturnValue({
      transactionId: TRANSACTION_ID,
      status: 'completed',
      refund: { status: 'completed', refundId: 'rf_full', amount: 5000 }, // the whole payment
    });

    await PaymentService.handleWebhook('paymob', { fake: true }, 'sig', STORE_ID);

    expect(applyRefundEffects).toHaveBeenCalledOnce();
    expect(refundWrite()?.status).toBe('refunded');
  });

  it('marks the payment refunded only when the arithmetic says it is settled', async () => {
    paymentWith(5000, 'partially_refunded');

    await PaymentService.handleWebhook('paymob', { fake: true }, 'sig', STORE_ID);

    expect(refundWrite()?.status).toBe('refunded');
    expect(refundWrite()?.refundedAmount).toBe(5000);
  });
});

// ─── Whole-order fanout must follow the same arithmetic as the status ──────
//
// Once the write above stopped forcing 'refunded', a short out-of-band refund
// leaves the payment as 'partially_refunded' — which ReturnService accepts as
// a still-refundable source. The out-of-band branch, however, still ran the
// WHOLE-order `applyRefundEffects` and flipped the order to refunded with no
// amount check. That combination double-spends: gateway portal refund of
// 2000 on a 5000 payment → all inventory restored, coupon/loyalty reversed,
// full GL reversal posted, order marked refunded — and 3000 still refundable,
// so a later partial return fires a second REAL gateway refund and restores
// the same units again (the two paths guard on different idempotency markers:
// order-level vs refundKey).
describe('refund webhook — whole-order effects only for a refund that exhausts the payment', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockProviderConfig();
    assertValidTransitionMock.mockImplementation(() => undefined);
    applyRefundEffects.mockResolvedValue(undefined);
    orderUpdate.mockResolvedValue({});
  });

  /** Out-of-band refund: payment still 'completed', nothing ever accounted. */
  function outOfBandRefundOf(refundAmount: number | undefined) {
    paymentFindFirst.mockResolvedValue({
      id: PAYMENT_ID,
      orderId: ORDER_ID,
      amount: 5000,
      currency: 'EGP',
      status: 'completed',
      refundedAmount: 0,
      provider: 'paymob',
      metadata: {},
      order: { storeId: STORE_ID, store: { name: 'Test Store' }, status: 'shipped' },
    });
    providerParseWebhook.mockReturnValue({
      transactionId: TRANSACTION_ID,
      status: 'completed',
      refund: { status: 'completed', refundId: 'rf_p', amount: refundAmount },
    });
  }

  function refundWrite() {
    return paymentUpdate.mock.calls
      .map(c => (c[0] as { data: Record<string, unknown> }).data)
      .find(d => 'refundedAmount' in d);
  }

  it('a PARTIAL out-of-band refund runs no whole-order reversal and does not flip the order', async () => {
    outOfBandRefundOf(2000);

    await PaymentService.handleWebhook('paymob', { fake: true }, 'sig', STORE_ID);

    expect(
      applyRefundEffects,
      'a 2000-of-5000 refund must not reverse the whole order while 3000 stays refundable'
    ).not.toHaveBeenCalled();
    expect(orderUpdate).not.toHaveBeenCalled();
    // The balance is still recorded, so the returns flow can spend the rest.
    expect(refundWrite()?.status).toBe('partially_refunded');
    expect(refundWrite()?.refundedAmount).toBe(2000);
  });

  it('a refund that EXHAUSTS the payment still runs the whole-order reversal + order flip', async () => {
    outOfBandRefundOf(5000);

    await PaymentService.handleWebhook('paymob', { fake: true }, 'sig', STORE_ID);

    expect(applyRefundEffects).toHaveBeenCalledWith(STORE_ID, ORDER_ID);
    expect(orderUpdate).toHaveBeenCalledWith({
      where: { id: ORDER_ID, storeId: STORE_ID },
      data: { status: 'refunded', paymentStatus: 'refunded' },
    });
    expect(refundWrite()?.status).toBe('refunded');
  });

  it('an unreported refund amount is treated as full — terminal status, no refundable remainder', async () => {
    // a provider's parseWebhook falls back to 0 when the payload carries no
    // RefundAmount/Amount. That is missing data, not a partial refund: leaving
    // the payment 'partially_refunded' there would be the same double-spend in
    // its worst form (whole-order reversal ran, full amount still refundable).
    outOfBandRefundOf(undefined);

    await PaymentService.handleWebhook('paymob', { fake: true }, 'sig', STORE_ID);

    expect(applyRefundEffects).toHaveBeenCalledWith(STORE_ID, ORDER_ID);
    expect(refundWrite()?.status).toBe('refunded');
  });
});

describe('refund webhook — what it cannot book is raised, not logged (#1477, #1455)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockProviderConfig();
    assertValidTransitionMock.mockImplementation(() => undefined);
    applyRefundEffects.mockResolvedValue(undefined);
  });

  function webhookFor(
    payment: { refundedAmount: number; status: string; metadata: Record<string, unknown> },
    refund: { refundId: string; amount?: number }
  ) {
    paymentFindFirst.mockResolvedValue({
      id: PAYMENT_ID,
      orderId: ORDER_ID,
      amount: 5000,
      currency: 'EGP',
      provider: 'paymob',
      ...payment,
      order: {
        storeId: STORE_ID,
        orderNumber: 'ORD-1',
        store: { name: 'Test Store' },
        status: 'delivered',
      },
    });
    providerParseWebhook.mockReturnValue({
      transactionId: TRANSACTION_ID,
      status: 'completed',
      refund: { status: 'completed', ...refund },
    });
  }

  const alertSources = async () => {
    const { sendAlert } = await import('@api/services/alerts.service');
    return vi.mocked(sendAlert).mock.calls.map(c => (c[0] as { source: string }).source);
  };

  /**
   * #1477. 2000 of a 5000 payment is accounted (rf_a). A NEW refund id arrives
   * with no usable amount: the total is held — it cannot be added blind — so if
   * it is a genuine second refund the payment still looks 3000 refundable, and
   * a later return would pay that out again. The hold is right; silence is not.
   */
  it('a refund nothing has counted, reported without an amount, raises an alert', async () => {
    webhookFor(
      {
        refundedAmount: 2000,
        status: 'partially_refunded',
        metadata: { refundEventIds: ['rf_a'], refundStatusById: { rf_a: 'completed' } },
      },
      { refundId: 'rf_new' }
    );

    await PaymentService.handleWebhook('paymob', { fake: true }, 'sig', STORE_ID);

    expect(await alertSources()).toContain('payment.refund.held_unaccounted');
  });

  // PR 2279 audit P1: a payment that predates the per-refund ledger (2000
  // refunded, no ids recorded) gets a NEW refund with a usable amount. It is
  // held, not added — the balance may be overstated — so it must page, under
  // its own kind.
  it('a refund with an amount on a pre-ledger payment raises held_provenance_unknown', async () => {
    webhookFor(
      { refundedAmount: 2000, status: 'partially_refunded', metadata: {} },
      { refundId: 'rf_new', amount: 3000 }
    );

    await PaymentService.handleWebhook('paymob', { fake: true }, 'sig', STORE_ID);

    expect(await alertSources()).toContain('payment.refund.held_provenance_unknown');
    expect(await alertSources()).not.toContain('payment.refund.held_unaccounted');
  });

  const claimRow = (claimId: string, amount: number, ageMs = 1000) => ({
    eventType: 'refund_initiated',
    createdAt: new Date(Date.now() - ageMs),
    details: { claimId, amount },
  });
  const absorbedEvents = () =>
    paymentEventCreateMock.mock.calls
      .map(c => (c[0] as { data: { eventType: string; details: Record<string, unknown> } }).data)
      .filter(d => d.eventType === 'refund_webhook_absorbed');

  it('a settle webhook that outruns the in-band id write is absorbed: total unchanged, the CLAIM is consumed (event carries its id)', async () => {
    paymentEventFindManyMock.mockResolvedValueOnce([claimRow('claim-1', 1000)]);
    webhookFor(
      {
        refundedAmount: 3000,
        status: 'partially_refunded',
        metadata: { refundEventIds: ['rf_a'], refundStatusById: { rf_a: 'completed' } },
      },
      { refundId: 'rf_new', amount: 1000 }
    );
    await PaymentService.handleWebhook('paymob', { fake: true }, 'sig', STORE_ID);
    const write = paymentUpdate.mock.calls.at(-1)?.[0] as { data: { refundedAmount?: number } };
    expect(write.data.refundedAmount).toBe(3000);
    expect(absorbedEvents()).toEqual([
      expect.objectContaining({
        details: expect.objectContaining({ claimId: 'claim-1', refundId: 'rf_new' }),
      }),
    ]);
    expect(recordRefundOutsideReturn).not.toHaveBeenCalled();
  });

  it('a STALE claim (older than the window) does not absorb: the same webhook is a new refund and adds', async () => {
    paymentEventFindManyMock.mockResolvedValueOnce([claimRow('claim-old', 1000, 10 * 60_000)]);
    webhookFor(
      {
        refundedAmount: 3000,
        status: 'partially_refunded',
        metadata: { refundEventIds: ['rf_a'], refundStatusById: { rf_a: 'completed' } },
      },
      { refundId: 'rf_new', amount: 1000 }
    );
    await PaymentService.handleWebhook('paymob', { fake: true }, 'sig', STORE_ID);
    const write = paymentUpdate.mock.calls.at(-1)?.[0] as { data: { refundedAmount?: number } };
    expect(write.data.refundedAmount).toBe(4000);
    expect(absorbedEvents()).toEqual([]);
  });

  it('the settle notice for an already-counted refund raises nothing (control)', async () => {
    webhookFor(
      {
        refundedAmount: 2000,
        status: 'partially_refunded',
        metadata: { refundEventIds: ['rf_a'], refundStatusById: { rf_a: 'pending' } },
      },
      { refundId: 'rf_a', amount: 2000 }
    );

    await PaymentService.handleWebhook('paymob', { fake: true }, 'sig', STORE_ID);

    expect(await alertSources()).toEqual([]);
  });

  /**
   * #1455, owner decision 2026-10-01: a partial refund made in the provider's
   * dashboard is booked as a revenue refund for THIS event's amount, keyed on
   * the provider's refund id, with no stock movement — no longer only raised.
   */
  it('a partial out-of-band refund is booked as a revenue refund for its amount', async () => {
    webhookFor(
      { refundedAmount: 0, status: 'completed', metadata: {} },
      {
        refundId: 'rf_p',
        amount: 2000,
      }
    );

    await PaymentService.handleWebhook('paymob', { fake: true }, 'sig', STORE_ID);

    expect(recordRefundOutsideReturn).toHaveBeenCalledOnce();
    expect(recordRefundOutsideReturn).toHaveBeenCalledWith(STORE_ID, ORDER_ID, {
      providerRefundId: 'rf_p',
      amount: 2000,
    });
    expect(applyRefundEffects).not.toHaveBeenCalled();
    expect(await alertSources()).not.toContain('payment.refund.partial_no_gl');
  });

  it('the settle notice for a refund already accounted books nothing more (control)', async () => {
    webhookFor(
      {
        refundedAmount: 2000,
        status: 'partially_refunded',
        metadata: { refundEventIds: ['rf_p'] },
      },
      { refundId: 'rf_p', amount: 2000 }
    );

    await PaymentService.handleWebhook('paymob', { fake: true }, 'sig', STORE_ID);

    expect(recordRefundOutsideReturn).not.toHaveBeenCalled();
  });
});

describe('PaymentService.refund — a partial refund outside a return is booked (#1209)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockProviderConfig();
    assertValidTransitionMock.mockImplementation(() => undefined);
    paymentFindFirst.mockResolvedValue({
      id: PAYMENT_ID,
      orderId: ORDER_ID,
      amount: 5000,
      refundedAmount: 0,
      status: 'completed',
      provider: 'paymob',
      metadata: {},
      order: {
        storeId: STORE_ID,
        orderNumber: 'ORD-1',
        store: { name: 'Test Store' },
        status: 'delivered',
      },
    });
    paymentUpdateMany.mockResolvedValue({ count: 1 });
    providerRefund.mockResolvedValue({
      success: true,
      provider: 'paymob',
      refundId: 'rf_1',
      transactionId: TRANSACTION_ID,
      amount: 1000,
      status: 'pending',
    });
  });

  const alertSources = async () => {
    const { sendAlert } = await import('@api/services/alerts.service');
    return vi.mocked(sendAlert).mock.calls.map(c => (c[0] as { source: string }).source);
  };

  it('the order page partial refund is booked as a revenue refund, sent now', async () => {
    await PaymentService.refund({ transactionId: TRANSACTION_ID, amount: 1000 });
    expect(recordRefundOutsideReturn).toHaveBeenCalledWith(
      STORE_ID,
      ORDER_ID,
      { providerRefundId: 'rf_1', amount: 1000 },
      { sendNow: true }
    );
    expect(await alertSources()).toEqual([]);
  });

  it('when that event cannot be queued, it alerts instead of failing the refund', async () => {
    recordRefundOutsideReturn.mockRejectedValueOnce(new Error('inngest down'));
    await expect(
      PaymentService.refund({ transactionId: TRANSACTION_ID, amount: 1000 })
    ).resolves.toMatchObject({ refundId: 'rf_1' });
    expect(await alertSources()).toContain('payment.refund.partial_no_gl');
  });

  it('a return books its own partial journal, so it does not (control)', async () => {
    await PaymentService.refund({
      transactionId: TRANSACTION_ID,
      amount: 1000,
      refundKey: 'return:r1',
      itemLevel: true,
    });
    expect(await alertSources()).toEqual([]);
    expect(recordRefundOutsideReturn).not.toHaveBeenCalled();
  });
});

describe('handleWebhook — a provider id matching MORE than one payment is refused (issue 769)', () => {
  it('throws AMBIGUOUS_PAYMENT and writes nothing', async () => {
    vi.clearAllMocks();
    mockProviderConfig();
    providerParseWebhook.mockReturnValue({
      transactionId: TRANSACTION_ID,
      status: 'completed',
      amount: 5000,
    });
    const row = (id: string, storeId: string) => ({
      id,
      orderId: `order-${id}`,
      amount: 5000,
      currency: 'EGP',
      status: 'pending',
      provider: 'paymob',
      metadata: {},
      order: { storeId, store: { name: 'S' }, status: 'pending' },
    });
    paymentFindManyOverride = async () => [row('pay-a', 'store-a'), row('pay-b', 'store-b')];
    try {
      await expect(
        // The store is always resolved before a webhook is handled: the global
        // (store-less) provider-config fallback is gone, so a store-less call is refused.
        PaymentService.handleWebhook('paymob', { fake: true }, 'sig', STORE_ID)
      ).rejects.toMatchObject({ statusCode: 409, code: 'AMBIGUOUS_PAYMENT' });
      expect(paymentUpdateMany).not.toHaveBeenCalled();
      expect(paymentUpdate).not.toHaveBeenCalled();
      // …and LOUDLY: a P0 naming the provider, the ids and every matching payment.
      const { sendAlert } = await import('@api/services/alerts.service');
      const p0 = vi
        .mocked(sendAlert)
        .mock.calls.map(
          c => c[0] as { level: string; source: string; context: Record<string, unknown> }
        )
        .find(a => a.source === 'payment.webhook.ambiguous_payment');
      expect(p0).toBeDefined();
      expect(p0!.level).toBe('p0');
      expect(p0!.context).toMatchObject({
        provider: 'paymob',
        transactionId: TRANSACTION_ID,
        paymentIds: ['pay-a', 'pay-b'],
      });
    } finally {
      paymentFindManyOverride = null;
    }
  });
});

/**
 * Issue 2065 (owner decision 2026-10-01, ruling RL-2a): a webhook is saved
 * first but NEVER acted on until its signature verifies. `handleWebhook` used
 * to skip verification entirely when no signature was passed (fail-open).
 * Mutation-proof: restoring `if (signature) { verify }` reddens the first case.
 */
describe('PaymentService.handleWebhook — never acts before a signature verifies (issue 2065)', () => {
  it.each([undefined, ''])(
    'signature %j is refused before anything is read or written',
    async sig => {
      vi.clearAllMocks();
      await expect(
        PaymentService.handleWebhook('paymob', { fake: true }, sig as string | undefined, STORE_ID)
      ).rejects.toMatchObject({ statusCode: 400, code: 'MISSING_SIGNATURE' });
      expect(providerParseWebhook).not.toHaveBeenCalled();
      expect(paymentUpdateMany).not.toHaveBeenCalled();
      expect(paymentUpdate).not.toHaveBeenCalled();
    }
  );
});
