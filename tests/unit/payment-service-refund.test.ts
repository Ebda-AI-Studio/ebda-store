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
const paymentEventFindFirst = vi.fn().mockResolvedValue(null);
const paymentEventFindMany = vi.fn().mockResolvedValue([]);
const paymentEventCreate = vi.fn().mockResolvedValue({});

let paymentFindManyOverride: ((...a: unknown[]) => Promise<unknown[]>) | null = null;

vi.mock('@ebda/database', () => ({
  prisma: {
    payment: {
      findFirst: (...a: unknown[]) => paymentFindFirst(...a),
      // refund() resolves by transactionId with findMany({ take: 2 }) and
      // refuses more than one match (issue 769); a single fixture row here.
      findMany: async (...a: unknown[]) => {
        if (paymentFindManyOverride) return paymentFindManyOverride(...a);
        const r = await paymentFindFirst(...a);
        return r ? [r] : [];
      },
      updateMany: (...a: unknown[]) => paymentUpdateMany(...a),
      update: (...a: unknown[]) => paymentUpdate(...a),
      // the claim just made: 1000 of a 5000 payment (readPayment in refund-settle re-reads it)
      findUnique: vi.fn().mockResolvedValue({
        id: 'pay_1',
        amount: 5000,
        currency: 'EGP',
        status: 'partially_refunded',
        refundedAmount: 1000,
        metadata: {},
      }),
    },
    order: {
      findUnique: (...a: unknown[]) => orderFindUnique(...a),
      update: (...a: unknown[]) => orderUpdate(...a),
    },
    providerActivationRequest: { findMany: async () => [] },
    paymentConfig: {
      findMany: (...a: unknown[]) => paymentConfigFindMany(...a),
    },
    $transaction: (ops: unknown[]) => txMock(ops),
    // PaymentService.refund's ledger rows (claim / completed / released).
    paymentEvent: {
      create: (...a: unknown[]) => paymentEventCreate(...a),
      findMany: (...a: unknown[]) => paymentEventFindMany(...a),
      findFirst: (...a: unknown[]) => paymentEventFindFirst(...a),
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
const recordRefundOutsideReturn = vi.fn();
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
    recordRefundOutsideReturn: (...a: unknown[]) => recordRefundOutsideReturn(...a),
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
    provider: 'paymob',
    metadata: {},
    order: { storeId: STORE_ID, store: {}, status: 'confirmed' },
  });
  paymentUpdateMany.mockResolvedValue({ count: 1 });
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
  providerRefund.mockResolvedValue({
    success: true,
    provider: 'paymob',
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

describe('PaymentService.refund — the claim is a compare-and-swap, not a plain status flip', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  /**
   * A plain `status === 'completed'` read-check is a TOCTOU race: two
   * concurrent refund requests (admin double-click, client retry, two staff
   * on one order) both read 'completed', both pass, and both call
   * provider.refund() — a double refund at the gateway with no undo API. The
   * guard is a compare-and-swap on `refundedAmount`: the claim's WHERE must
   * match the balance this call just read, so a second concurrent claim
   * (which wrote a different refundedAmount first) cannot also match.
   *
   * This asserts the CAS is actually issued — not merely that a race is
   * refused (the test below covers that), which a status-only claim would
   * also pass in isolation.
   */
  it('claims the payment with a WHERE that pins refundedAmount to the balance just read', async () => {
    mockHappyPathUpToEffects();
    applyRefundEffects.mockResolvedValue(undefined);

    await PaymentService.refund({ transactionId: TRANSACTION_ID });

    expect(paymentUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ refundedAmount: 0 }),
      })
    );
  });

  /**
   * `claim.count === 0` means some OTHER request's claim won the race — the
   * balance this request read is already stale. Refusing here, before the
   * provider is ever called, is the only thing standing between that race
   * and a double refund at the gateway.
   */
  it('refuses the refund and never calls the provider when the claim loses the race', async () => {
    mockHappyPathUpToEffects();
    paymentUpdateMany.mockResolvedValue({ count: 0 }); // lost the race

    await expect(PaymentService.refund({ transactionId: TRANSACTION_ID })).rejects.toThrow(
      /not refundable|already in progress/i
    );

    expect(providerRefund).not.toHaveBeenCalled();
    expect(applyRefundEffects).not.toHaveBeenCalled();
  });
});

/**
 * #1487 — the in-band refund must seed the per-refund status map alongside the
 * accounted-id list. With the map empty, isRefundEventAlreadySeen falls back to
 * the payment-wide `refundStatus` scalar, and once that reads 'completed' the
 * NEXT (out-of-band) refund's webhook is dropped unread.
 */
describe('PaymentService.refund — per-refund ledger bookkeeping', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('records both the accounted refund id and its status', async () => {
    mockHappyPathUpToEffects();
    applyRefundEffects.mockResolvedValue(undefined);

    await PaymentService.refund({ transactionId: TRANSACTION_ID, amount: 1000 });

    const write = paymentUpdate.mock.calls.find(
      c => (c[0] as { data?: { refundId?: string } }).data?.refundId === 'rf_123'
    );
    const meta = (write?.[0] as { data: { metadata: Record<string, unknown> } }).data.metadata;
    expect(meta.refundEventIds).toEqual(['rf_123']);
    expect(meta.refundStatusById).toEqual({ rf_123: 'completed' });
  });
});

describe('PaymentService.refund — one refund per key (a retry after a rollback)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    paymentEventFindMany.mockResolvedValue([]);
  });

  /**
   * The caller's own mutex (the Return's completion claim) lives in the
   * request transaction and is rolled back by the very 5xx that follows a
   * failure after the money left, so the return is retryable while the refund
   * stands. The committed claim for the same key is what refuses the retry.
   */
  it('refuses a key whose earlier refund was never released, before the provider', async () => {
    mockHappyPathUpToEffects();
    paymentEventFindMany.mockResolvedValue([
      { eventType: 'refund_initiated', details: { claimId: 'c-earlier', refundKey: 'return:r1' } },
    ]);

    await expect(
      PaymentService.refund({ transactionId: TRANSACTION_ID, amount: 1000, refundKey: 'return:r1' })
    ).rejects.toMatchObject({ code: 'REFUND_ALREADY_ISSUED', statusCode: 409 });
    expect(providerRefund).not.toHaveBeenCalled();
  });

  it('a released earlier claim does not block a retry (control)', async () => {
    mockHappyPathUpToEffects();
    paymentEventFindMany.mockResolvedValue([
      { eventType: 'refund_initiated', details: { claimId: 'c-earlier', refundKey: 'return:r1' } },
      { eventType: 'refund_failed', details: { claimId: 'c-earlier', refundKey: 'return:r1' } },
    ]);

    await PaymentService.refund({
      transactionId: TRANSACTION_ID,
      amount: 1000,
      refundKey: 'return:r1',
    });
    expect(providerRefund).toHaveBeenCalledOnce();
  });
});

describe('PaymentService.refund — a provider failure keeps or releases the claim by what it proves', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    paymentEventFindMany.mockResolvedValue([]);
  });

  /** The release is the decrement write; the claim is the compare-and-swap. */
  const releaseWrites = () =>
    paymentUpdate.mock.calls.filter(
      c => typeof (c[0] as { data: { refundedAmount?: unknown } }).data.refundedAmount === 'number'
    );

  it('a timeout KEEPS the claim and reports that the refund may have gone out (#1359)', async () => {
    mockHappyPathUpToEffects();
    providerRefund.mockRejectedValue(new Error('The operation was aborted due to timeout'));

    const err = await PaymentService.refund({ transactionId: TRANSACTION_ID, amount: 1000 }).catch(
      e => e
    );

    expect(err).toMatchObject({ code: 'PROVIDER_REFUND_INDETERMINATE' });
    const { refundMayHaveExecuted } =
      await import('@api/services/payment-providers/refund-outcome');
    expect(refundMayHaveExecuted(err)).toBe(true);
    expect(releaseWrites(), 'the balance must not be reset on a timeout').toEqual([]);
  });

  it('an explicit provider refusal RELEASES the claim', async () => {
    mockHappyPathUpToEffects();
    const { ProviderRejectedError, refundMayHaveExecuted } =
      await import('@api/services/payment-providers/refund-outcome');
    providerRefund.mockRejectedValue(new ProviderRejectedError('Invalid amount', 400));
    paymentUpdateMany.mockResolvedValue({ count: 1 });

    const err = await PaymentService.refund({ transactionId: TRANSACTION_ID, amount: 1000 }).catch(
      e => e
    );

    expect(err).toBeInstanceOf(ProviderRejectedError);
    expect(refundMayHaveExecuted(err)).toBe(false);
    expect(releaseWrites()).toHaveLength(1);
  });
});

describe('PaymentService.refund — the claim event carries what the settlement rules read back', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    paymentEventFindMany.mockResolvedValue([]);
  });
  it('isFullRefund / flipsOrder / priorStatus are on the claim event (Fawry kind matching needs isFullRefund)', async () => {
    mockHappyPathUpToEffects();
    applyRefundEffects.mockResolvedValue(undefined);
    await PaymentService.refund({ transactionId: TRANSACTION_ID, amount: 1000 }).catch(e => e);
    const claim = paymentEventCreate.mock.calls
      .map(c => (c[0] as { data: { eventType: string; details: Record<string, unknown> } }).data)
      .find(d => d.eventType === 'refund_initiated');
    expect(claim?.details).toMatchObject({ isFullRefund: false, flipsOrder: false });
    expect(typeof claim?.details.priorStatus).toBe('string');
  });
});

describe('PaymentService.refund — a claim whose answered id was already filed under another claim is closed', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    paymentEventFindMany.mockResolvedValue([]);
    paymentEventFindFirst.mockResolvedValue(null);
  });
  it('writes an id_match_reassigned consume event so the claim cannot hold later refunds forever', async () => {
    mockHappyPathUpToEffects();
    // the ledger already holds rf_123 (a webhook with that id was absorbed by a same-amount sibling claim)
    paymentUpdateMany.mockResolvedValue({ count: 1 });
    const { prisma } = await import('@ebda/database');
    (prisma.payment.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: 'pay_1',
      amount: 5000,
      currency: 'EGP',
      status: 'partially_refunded',
      refundedAmount: 2000,
      metadata: { refundEventIds: ['rf_123'] },
    });
    await PaymentService.refund({ transactionId: TRANSACTION_ID, amount: 1000 }).catch(e => e);
    const types = paymentEventCreate.mock.calls.map(
      c => (c[0] as { data: { eventType: string; details?: Record<string, unknown> } }).data
    );
    expect(
      types.some(
        d => d.eventType === 'refund_webhook_absorbed' && d.details?.via === 'id_match_reassigned'
      )
    ).toBe(true);
  });
});

describe('PaymentService.refund — a claim a webhook already absorbed is never released', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    paymentEventFindMany.mockResolvedValue([]);
    paymentEventFindFirst.mockResolvedValue(null);
  });
  it('the provider refuses AFTER a webhook reported the refund completed: no balance given back, a review event is written', async () => {
    mockHappyPathUpToEffects();
    const { ProviderRejectedError } =
      await import('@api/services/payment-providers/refund-outcome');
    providerRefund.mockRejectedValue(new ProviderRejectedError('Invalid amount', 400));
    paymentUpdateMany.mockResolvedValue({ count: 1 });
    // a settle webhook consumed THIS claim (the claim id is generated inside refund(): read it from the claim event)
    paymentEventFindMany.mockImplementation(async () => {
      const claim = paymentEventCreate.mock.calls
        .map(c => (c[0] as { data: { eventType: string; details: { claimId: string } } }).data)
        .find(d => d.eventType === 'refund_initiated');
      return [
        {
          eventType: 'refund_webhook_absorbed',
          createdAt: new Date(),
          details: { claimId: claim?.details.claimId },
        },
      ];
    });
    await PaymentService.refund({ transactionId: TRANSACTION_ID, amount: 1000 }).catch(e => e);
    expect(
      paymentUpdate.mock.calls.filter(
        c =>
          typeof (c[0] as { data: { refundedAmount?: unknown } }).data.refundedAmount === 'number'
      )
    ).toEqual([]);
    const types = paymentEventCreate.mock.calls.map(
      c => (c[0] as { data: { eventType: string } }).data.eventType
    );
    expect(types).toContain('refund_reconcile_review');
  });
});

describe('PaymentService.refund — an item-level refund never reverses the order (#1402)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    paymentEventFindMany.mockResolvedValue([]);
  });

  it('uses up the payment but leaves the order and its whole-order effects alone', async () => {
    mockHappyPathUpToEffects();
    applyRefundEffects.mockResolvedValue(undefined);

    const result = await PaymentService.refund({
      transactionId: TRANSACTION_ID,
      amount: 5000, // the whole payment
      itemLevel: true,
      refundKey: 'return:r1',
    });

    expect(result.wholeOrderEffectsApplied).toBe(false);
    expect(applyRefundEffects).not.toHaveBeenCalled();
    expect(orderUpdate).not.toHaveBeenCalled();
    // The PAYMENT is still spent — only the order is left as it is.
    const claim = paymentUpdateMany.mock.calls[0]?.[0] as { data: { status: string } };
    expect(claim.data.status).toBe('refunded');
  });

  it('without the flag the same amount reverses the order (control)', async () => {
    mockHappyPathUpToEffects();
    applyRefundEffects.mockResolvedValue(undefined);

    const result = await PaymentService.refund({ transactionId: TRANSACTION_ID, amount: 5000 });

    expect(result.wholeOrderEffectsApplied).toBe(true);
    expect(applyRefundEffects).toHaveBeenCalledWith(STORE_ID, ORDER_ID);
  });
});

describe('PaymentService.refund — a transaction id matching more than one payment (issue 769)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('refuses with AMBIGUOUS_PAYMENT before any claim or provider call', async () => {
    mockHappyPathUpToEffects();
    paymentFindManyOverride = async () => [
      { id: 'pay-a', transactionId: TRANSACTION_ID },
      { id: 'pay-b', transactionId: TRANSACTION_ID },
    ];
    try {
      await expect(
        PaymentService.refund({ transactionId: TRANSACTION_ID, amount: 1000 })
      ).rejects.toMatchObject({ statusCode: 409, code: 'AMBIGUOUS_PAYMENT' });
      expect(providerRefund).not.toHaveBeenCalled();
      expect(paymentUpdateMany).not.toHaveBeenCalled();
    } finally {
      paymentFindManyOverride = null;
    }
  });
});

/**
 * Issue 2310 — a partial refund outside a return is booked under the
 * provider's refund id. When the provider returned NO id, the old fallback
 * `claim-<claimId>` booked it under a key the settle webhook (which carries
 * the REAL id) would never repeat — one refund, two journal entries. Now it
 * books nothing and pages. Mutation-proof: restoring the fallback reddens it.
 */
describe('PaymentService.refund — never invents a GL key (issue 2310)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('a provider refund with no refund id is NOT booked, and a P1 is raised', async () => {
    const { sendAlert } = await import('@api/services/alerts.service');
    mockHappyPathUpToEffects();
    providerRefund.mockResolvedValue({
      success: true,
      provider: 'paymob',
      refundId: '',
      transactionId: TRANSACTION_ID,
      amount: 1000,
      status: 'completed',
    });

    await PaymentService.refund({ transactionId: TRANSACTION_ID, amount: 1000 });

    expect(recordRefundOutsideReturn).not.toHaveBeenCalled();
    expect(sendAlert).toHaveBeenCalledWith(
      expect.objectContaining({ source: 'payment.refund.partial_no_gl' })
    );
  });

  it('with a provider refund id it books under exactly that id (control)', async () => {
    mockHappyPathUpToEffects();
    recordRefundOutsideReturn.mockResolvedValue(undefined);

    await PaymentService.refund({ transactionId: TRANSACTION_ID, amount: 1000 });

    expect(recordRefundOutsideReturn).toHaveBeenCalledWith(
      STORE_ID,
      ORDER_ID,
      { providerRefundId: 'rf_123', amount: 1000 },
      { sendNow: true }
    );
  });
});
