/**
 * PaymentService.refund unit tests (money-integrity Task 5)
 *
 * Root-cause coverage for the admin "refund via provider" swallow: after the
 * provider refund succeeds and the Payment/Order rows are flipped to
 * `refunded`, `refund()` calls `OrderService.applyRefundEffects` — which, per
 * the Task 1-4 redesign, is now a thin `inngest.send('order/refunded', ...)`
 * dispatcher that fires the ONLY signal driving inventory/coupon/affiliate/
 * loyalty reversal + the customer refund email/admin push. Historically that
 * call was wrapped in a try/catch that only logged the failure (added back
 * when `applyRefundEffects` did heavy inline work and a failure there was
 * genuinely "non-fatal" reconciliation debt). Now that it's the sole fanout
 * trigger, swallowing its failure means the reversal/notification chain can
 * silently never fire while `refund()` still resolves normally — and the
 * admin `refund-via-provider` route (order.routes.ts) has no way to know,
 * so it returns HTTP 200 despite a broken refund (money-integrity audit F2).
 *
 * This test asserts `PaymentService.refund()` REJECTS when
 * `applyRefundEffects` throws, so the failure can propagate to the route's
 * error handling instead of being swallowed here.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mocks (declared before the module-under-test import) ────────────────

const paymentFindFirst = vi.fn();
const paymentUpdateMany = vi.fn();
const paymentUpdate = vi.fn().mockResolvedValue({});
const orderUpdate = vi.fn().mockResolvedValue({});
const orderFindUnique = vi.fn();
const paymentConfigFindMany = vi.fn();
// `$transaction` is called with an ARRAY of already-built update promises
// (`prisma.payment.update(...)`, `prisma.order.update(...)`), so those two
// must resolve on their own before `$transaction` ever runs.
const txMock = vi.fn((ops: unknown[]) => Promise.all(ops));

vi.mock('@force/database', () => ({
  prisma: {
    payment: {
      findFirst: (...a: unknown[]) => paymentFindFirst(...a),
      updateMany: (...a: unknown[]) => paymentUpdateMany(...a),
      update: (...a: unknown[]) => paymentUpdate(...a),
    },
    order: {
      findUnique: (...a: unknown[]) => orderFindUnique(...a),
      update: (...a: unknown[]) => orderUpdate(...a),
    },
    paymentConfig: {
      findMany: (...a: unknown[]) => paymentConfigFindMany(...a),
    },
    $transaction: (ops: unknown[]) => txMock(ops),
  },
  Prisma: {},
}));

vi.mock('@api/config', () => ({
  config: {
    paymentTestMode: true,
  },
}));

vi.mock('@api/services/encryption.service', () => ({
  encryption: {
    decrypt: (v: string) => v,
    encrypt: (v: string) => v,
  },
}));

// The function under test (`refund`) fans out to `applyRefundEffects` after
// the DB transaction commits — this is the mock under direct test control.
const applyRefundEffects = vi.fn();
// `refund()` now also calls the money-integrity Task 6 state machine guard
// before the DB flip. These tests aren't exercising the guard itself
// (see tests/unit/order-status-machine.test.ts and
// tests/unit/payment-webhook-status-transition.test.ts for that) — the
// mocked order below is always in a valid pre-refund state ('confirmed'),
// so a no-op pass-through here keeps this file focused on the
// applyRefundEffects-swallow regression it was written for.
vi.mock('@api/services/order.service', () => ({
  OrderService: {
    applyRefundEffects: (...a: unknown[]) => applyRefundEffects(...a),
  },
  assertValidTransition: () => undefined,
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
  redis: { get: vi.fn(), set: vi.fn(), del: vi.fn() },
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

// The provider's own `.refund()` call — always succeeds in these tests; we
// are testing what happens AFTER the provider (and the DB tx) succeed.
const providerRefund = vi.fn();
vi.mock('@api/services/payment-providers/tap.provider', () => ({
  TapPaymentProvider: class {
    initialize = vi.fn();
    refund = providerRefund;
  },
}));
vi.mock('@api/services/payment-providers/myfatoorah.provider', () => ({
  MyFatoorahPaymentProvider: class {
    initialize = vi.fn();
    refund = providerRefund;
  },
}));
vi.mock('@api/services/payment-providers/hesabe.provider', () => ({
  HesabePaymentProvider: class {
    initialize = vi.fn();
    refund = providerRefund;
  },
}));
vi.mock('@api/services/payment-providers/upayments.provider', () => ({
  UPaymentsProvider: class {
    initialize = vi.fn();
    refund = providerRefund;
  },
}));

import { PaymentService } from '@api/services/payment-providers/payment.factory';

const PAYMENT_ID = 'pay_1';
const ORDER_ID = 'order_1';
const STORE_ID = 'store_1';
const TRANSACTION_ID = 'txn_1';

function mockHappyPathUpToEffects() {
  paymentFindFirst.mockResolvedValue({
    id: PAYMENT_ID,
    orderId: ORDER_ID,
    amount: 5000,
    status: 'completed',
    provider: 'myfatoorah',
    metadata: {},
    order: { storeId: STORE_ID, store: {}, status: 'confirmed' },
  });
  paymentUpdateMany.mockResolvedValue({ count: 1 });
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
  providerRefund.mockResolvedValue({
    success: true,
    provider: 'myfatoorah',
    refundId: 'rf_123',
    transactionId: TRANSACTION_ID,
    amount: 5000,
    status: 'completed',
  });
  txMock.mockResolvedValue([{}, {}]);
  orderFindUnique.mockResolvedValue({ storeId: STORE_ID });
}

/**
 * `amount: 0` must never mean "refund the whole payment".
 *
 * `Return.refundAmount` is `Int @default(0)` and NOT NULL, so
 * `ReturnService.complete`'s `returnRequest.refundAmount ?? undefined` handed
 * this function a literal 0 whenever the merchant never entered an amount —
 * and the old `isFullRefund = !request.amount || …` read 0 as full. A merchant
 * completing a PARTIAL return with refundMethod 'gateway' refunded the
 * customer the ENTIRE order at the provider, and the whole-order
 * `order/refunded` that follows reversed the whole sale journal, erasing the
 * revenue, tax and COGS for the items the customer kept.
 *
 * Fixed at the source rather than only at the caller: any future caller that
 * passes a computed 0 now gets a loud 400 before money moves, instead of the
 * most expensive possible interpretation of a falsy value.
 */
describe('PaymentService.refund — a zero amount is a caller bug, not a full refund', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each([0, -1])('rejects amount=%s without calling the provider', async amount => {
    mockHappyPathUpToEffects();

    await expect(PaymentService.refund({ transactionId: TRANSACTION_ID, amount })).rejects.toThrow(
      /greater than zero/i
    );

    expect(providerRefund).not.toHaveBeenCalled();
    expect(applyRefundEffects).not.toHaveBeenCalled();
  });

  it('an ABSENT amount still means the full payment (control)', async () => {
    mockHappyPathUpToEffects();
    applyRefundEffects.mockResolvedValue(undefined);

    await PaymentService.refund({ transactionId: TRANSACTION_ID });

    expect(providerRefund).toHaveBeenCalled();
    // Full refund runs the whole-order effects internally — this is the branch
    // ReturnService relies on for a genuinely full return.
    expect(applyRefundEffects).toHaveBeenCalled();
  });

  it('a genuine partial amount refunds at the provider and runs NO whole-order effects', async () => {
    mockHappyPathUpToEffects();
    applyRefundEffects.mockResolvedValue(undefined);

    await PaymentService.refund({ transactionId: TRANSACTION_ID, amount: 1000 });

    expect(providerRefund).toHaveBeenCalled();
    expect(applyRefundEffects).not.toHaveBeenCalled();
  });
});

describe('PaymentService.refund — applyRefundEffects failure must surface', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('REJECTS when applyRefundEffects throws after the provider refund + DB flip succeed', async () => {
    mockHappyPathUpToEffects();
    applyRefundEffects.mockRejectedValue(new Error('inngest.send failed: ECONNREFUSED'));

    await expect(PaymentService.refund({ transactionId: TRANSACTION_ID })).rejects.toThrow(
      'inngest.send failed'
    );
  });

  it('resolves normally when applyRefundEffects succeeds (control case)', async () => {
    mockHappyPathUpToEffects();
    applyRefundEffects.mockResolvedValue(undefined);

    const result = await PaymentService.refund({ transactionId: TRANSACTION_ID });

    expect(result.refundId).toBe('rf_123');
    expect(applyRefundEffects).toHaveBeenCalledWith(STORE_ID, ORDER_ID);
  });
});

describe('PaymentService.refund — an absent transaction id is refused, not looked up', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  /**
   * Prisma DROPS `undefined` filters, so `findFirst({ where: { transactionId:
   * undefined } })` is an EMPTY where and returns an ARBITRARY payment row.
   * Every step after it then runs against the wrong order — the claim writes
   * its status and refundedAmount, the transition guard checks its status, and
   * a successful provider call flips THAT order to refunded, restores its
   * inventory, reverses its GL and emails a refund notice to a customer who
   * returned nothing.
   *
   * COD payments are exactly this shape: created without a transaction id, and
   * flipped to 'completed' by the mark-COD-paid route without ever gaining one.
   */
  it.each([undefined, null, ''])('rejects %p before any lookup', async bad => {
    mockHappyPathUpToEffects();

    await expect(
      PaymentService.refund({ transactionId: bad as unknown as string })
    ).rejects.toThrow(/no provider transaction|cannot be refunded/i);

    expect(paymentFindFirst, 'an empty WHERE must never be issued').not.toHaveBeenCalled();
    expect(providerRefund).not.toHaveBeenCalled();
  });

  it('proceeds normally with a real transaction id (control)', async () => {
    mockHappyPathUpToEffects();
    applyRefundEffects.mockResolvedValue(undefined);

    await PaymentService.refund({ transactionId: TRANSACTION_ID });

    expect(paymentFindFirst).toHaveBeenCalled();
    expect(providerRefund).toHaveBeenCalled();
  });
});
