/**
 * `ReturnService.complete` — the gateway refund path, end to end.
 *
 * This file exists because nothing drove this method. `partial-return-allocation`
 * tests the arithmetic and `accounting-partial-return` calls the posting
 * function directly; neither goes through the sequence a merchant actually
 * triggers, and every bug below lived in exactly that gap:
 *
 *  1. `Return.refundAmount` is auto-computed at CREATION as the gross line
 *     value — `sum(price × qty)`, no order-level discount or tax — and nothing
 *     overwrites it (the routes expose only a tracking PUT; the admin renders
 *     it read-only). Passing it to the provider refunded the customer the
 *     pre-discount price while the journal credited the discounted one.
 *  2. Before that, `?? undefined` on a `NOT NULL DEFAULT 0` column passed a
 *     literal `0`, which the old `!request.amount` predicate read as "refund
 *     everything" — a partial return refunded the whole order and reversed the
 *     entire sale journal.
 *  3. `gatewayRanFullEffects` mirrored that same falsy predicate, so the
 *     item-level event was suppressed and the returned goods were never
 *     restocked.
 *
 * All three are the same root shape: a display/estimate column used as a money
 * instruction. The tests below pin the amount that leaves the gateway, because
 * that is the number the customer sees on their card.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';

const returnUpdate = vi.fn();
const returnUpdateMany = vi.fn();
const returnFindMany = vi.fn();
const orderFindFirst = vi.fn();
const orderItemFindMany = vi.fn();
const paymentFindFirst = vi.fn();
const providerRefund = vi.fn();
const applyRefundEffects = vi.fn();
const getById = vi.fn();
const findOutstandingRefundClaims = vi.fn();
// issue 2002: a non-gateway completion settles any open claim for its key.
const reconcileOutstandingRefundClaims = vi.fn().mockResolvedValue([]);

vi.mock('@ebda/database', () => ({
  prisma: {
    return: {
      update: (...a: unknown[]) => returnUpdate(...a),
      updateMany: (...a: unknown[]) => returnUpdateMany(...a),
      findMany: (...a: unknown[]) => returnFindMany(...a),
    },
    order: { findFirst: (...a: unknown[]) => orderFindFirst(...a) },
    orderItem: { findMany: (...a: unknown[]) => orderItemFindMany(...a) },
    // B2B Task 8b: what earlier completed returns retained per line, and the per-item adjustment write.
    returnItem: { findMany: async () => [], update: async () => ({}) },
    // Backorder single-line cancel markers — none in this file.
    orderEvent: { findMany: async () => [] },
    payment: { findFirst: (...a: unknown[]) => paymentFindFirst(...a) },
    // No `$executeRaw`: the order-level advisory lock is gone (Ruling NZ-REFUND-LOCK-1), so any raw SQL here throws.
  },
  Prisma: {},
  ReturnStatus: {},
  ReturnType: {},
}));

vi.mock('@api/services/payment-providers/payment.factory', () => ({
  PaymentService: { refund: (...a: unknown[]) => providerRefund(...a) },
  findOutstandingRefundClaims: (...a: unknown[]) => findOutstandingRefundClaims(...a),
  reconcileOutstandingRefundClaims: (...a: unknown[]) => reconcileOutstandingRefundClaims(...a),
}));
vi.mock('@api/services/order.service', () => ({
  OrderService: { applyRefundEffects: (...a: unknown[]) => applyRefundEffects(...a) },
}));
// Customer wallet (D1) OFF, as for every store at deploy: `store_credit`
// keeps its old off-platform meaning in this file. The wallet-ON branch is
// covered against a real DB in tests/integration/customer-wallet.test.ts.
vi.mock('@api/services/feature.service', () => ({
  featureService: { isFeatureEnabled: vi.fn().mockResolvedValue(false) },
}));
vi.mock('@api/services/email.service', () => ({ EmailService: {} }));
vi.mock('@api/services/socket.service', () => ({ socketService: { emitToStore: vi.fn() } }));
vi.mock('@api/lib/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { ReturnService } from '@api/services/return.service';
import { AppError } from '@api/middleware/error-handler';
import { markRefundMayHaveExecuted } from '@api/services/payment-providers/refund-outcome';

const STORE_ID = 'store-1';
const RETURN_ID = 'ret-1';
const ORDER_ID = 'order-1';

/**
 * The PR's own integration fixture: subtotal 9000, discount 1000, tax 900.
 * Two lines — A at 2000×2 and B at 5000×1 — so the order grosses 9000 and the
 * customer paid 8900 (9000 − 1000 + 900).
 */
const LINE_A = { id: 'oi-a', quantity: 2, price: 2000 };
const LINE_B = { id: 'oi-b', quantity: 1, price: 5000 };
const PAYMENT_TOTAL = 8900;

function setup({
  returnedItems,
  priorReturns = [],
  paymentStatus = 'completed',
  paymentRefunded = 0,
}: {
  returnedItems: Array<{ orderItemId: string; quantity: number }>;
  priorReturns?: Array<{ items: Array<{ orderItemId: string; quantity: number }> }>;
  /** What a prior partial gateway refund left the Payment row in. */
  paymentStatus?: string;
  paymentRefunded?: number;
}) {
  getById.mockResolvedValue({
    id: RETURN_ID,
    status: 'received',
    type: 'return',
    orderId: ORDER_ID,
    // GROSS, exactly as create() computes it — the value that must NOT be
    // handed to the provider.
    refundAmount: returnedItems.reduce((t, i) => {
      const line = [LINE_A, LINE_B].find(l => l.id === i.orderItemId)!;
      return t + line.price * i.quantity;
    }, 0),
    items: returnedItems.map(i => ({ orderItemId: i.orderItemId, quantity: i.quantity })),
  });
  vi.spyOn(ReturnService, 'getById').mockImplementation(getById as never);

  orderItemFindMany.mockResolvedValue([LINE_A, LINE_B]);
  // Honour the status filter the service sends: a payment left in
  // 'partially_refunded' by an earlier refund must still be FOUND, which is
  // exactly what the 'completed'-only filter used to get wrong.
  paymentFindFirst.mockImplementation((args: unknown) => {
    const filter = (args as { where?: { status?: unknown } } | undefined)?.where?.status;
    const allowed: string[] | undefined =
      typeof filter === 'string'
        ? [filter]
        : ((filter as { in?: string[] } | undefined)?.in ?? undefined);
    if (allowed && !allowed.includes(paymentStatus)) return Promise.resolve(null);
    return Promise.resolve({
      id: 'pay-1',
      transactionId: 'txn-1',
      amount: PAYMENT_TOTAL,
      status: paymentStatus,
      refundedAmount: paymentRefunded,
    });
  });
  returnFindMany.mockResolvedValue(priorReturns);
  orderFindFirst.mockResolvedValue({ subtotal: 9000, discount: 1000, tax: 900 });
  returnUpdate.mockImplementation((args: { data: unknown }) => ({ id: RETURN_ID, ...args.data }));
  // The atomic claim wins by default; individual tests override it to lose.
  returnUpdateMany.mockResolvedValue({ count: 1 });
  // Answers the way PaymentService.refund does: it reports whether IT ran the
  // whole-order effects — only for a refund that uses up what is left on the
  // payment and is not flagged item-level by the caller.
  providerRefund.mockImplementation(
    async (req: { amount?: number; itemLevel?: boolean; transactionId?: string }) => {
      const p = (await paymentFindFirst({ where: {} })) as {
        amount: number;
        refundedAmount?: number;
      } | null;
      const remaining = (p?.amount ?? 0) - (p?.refundedAmount ?? 0);
      return {
        success: true,
        refundId: 'rf-1',
        wholeOrderEffectsApplied: !req.itemLevel && (req.amount == null || req.amount >= remaining),
      };
    }
  );
  applyRefundEffects.mockResolvedValue(undefined);
  findOutstandingRefundClaims.mockResolvedValue([]);
  reconcileOutstandingRefundClaims.mockResolvedValue([]);
}

/** The amount handed to the payment provider on the single refund call. */
function refundedAmount() {
  return (providerRefund.mock.calls[0]?.[0] as { amount?: number })?.amount;
}

describe('ReturnService.complete — gateway refund amount', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.resetAllMocks();
  });

  it('refunds the NET allocated figure for a partial return, never the gross estimate', async () => {
    setup({ returnedItems: [{ orderItemId: 'oi-a', quantity: 1 }] });

    await ReturnService.complete(STORE_ID, RETURN_ID, 'user-1', 'gateway');

    // Gross would be 2000. The allocation is 2000 − (1000 × 2000/9000 = 222)
    // + (900 × 2000/9000 = 200) = 1978 — the same number the journal credits.
    expect(refundedAmount()).toBe(1978);
    expect(refundedAmount()).not.toBe(2000);
  });

  it('never passes zero or undefined for a partial return', async () => {
    // Absent means "the whole payment" to PaymentService, and zero used to as
    // well. Either would refund 8900 against a 1978 journal credit.
    setup({ returnedItems: [{ orderItemId: 'oi-a', quantity: 1 }] });

    await ReturnService.complete(STORE_ID, RETURN_ID, 'user-1', 'gateway');

    expect(refundedAmount()).toBeGreaterThan(0);
    expect(refundedAmount()).toBeLessThan(PAYMENT_TOTAL);
  });

  it('fires the ITEM-LEVEL event for a partial return, carrying the net amount', async () => {
    setup({ returnedItems: [{ orderItemId: 'oi-a', quantity: 1 }] });

    await ReturnService.complete(STORE_ID, RETURN_ID, 'user-1', 'gateway');

    const [, , opts] = applyRefundEffects.mock.calls[0] as [
      string,
      string,
      { partial?: { refundAmount?: number; items: unknown[] } },
    ];
    expect(opts?.partial).toBeTruthy();
    // The customer's refund notification reads this figure; it must be what
    // their card will actually show, not the gross estimate.
    expect(opts.partial?.refundAmount).toBe(1978);
  });

  it('records what was actually refunded, so the admin figure stops being a fiction', async () => {
    setup({ returnedItems: [{ orderItemId: 'oi-a', quantity: 1 }] });

    await ReturnService.complete(STORE_ID, RETURN_ID, 'user-1', 'gateway');

    const data = (returnUpdate.mock.calls[0]?.[0] as { data: { refundAmount?: number } }).data;
    expect(data.refundAmount).toBe(1978);
  });

  it('a FULL return passes an ABSENT amount — the whole payment, tax and shipping included', async () => {
    // The gross estimate (9000) is not the payment (8900): it excludes the
    // discount and the tax. Passing it would fail the >= payment.amount test
    // and a genuinely full return would be treated as partial.
    setup({
      returnedItems: [
        { orderItemId: 'oi-a', quantity: 2 },
        { orderItemId: 'oi-b', quantity: 1 },
      ],
    });

    await ReturnService.complete(STORE_ID, RETURN_ID, 'user-1', 'gateway');

    expect(refundedAmount()).toBeUndefined();
    // Full refund runs the whole-order effects inside PaymentService, so
    // complete() must NOT fire them again.
    expect(applyRefundEffects).not.toHaveBeenCalled();
  });

  it('accounts for a prior completed return when allocating', async () => {
    setup({
      returnedItems: [{ orderItemId: 'oi-a', quantity: 1 }],
      priorReturns: [{ items: [{ orderItemId: 'oi-a', quantity: 1 }] }],
    });

    await ReturnService.complete(STORE_ID, RETURN_ID, 'user-1', 'gateway');

    // Cumulative allocation: the second unit's share differs from the first by
    // at most a fil, and must never re-refund the first.
    expect(refundedAmount()).toBeGreaterThan(1970);
    expect(refundedAmount()).toBeLessThan(1990);
  });

  it('rejects rather than refunding when every claimed line is already returned', async () => {
    setup({
      returnedItems: [{ orderItemId: 'oi-a', quantity: 2 }],
      priorReturns: [{ items: [{ orderItemId: 'oi-a', quantity: 2 }] }],
    });

    await expect(ReturnService.complete(STORE_ID, RETURN_ID, 'user-1', 'gateway')).rejects.toThrow(
      /already covered/i
    );

    expect(providerRefund).not.toHaveBeenCalled();
  });

  /**
   * The first partial gateway refund leaves the Payment row in
   * 'partially_refunded' (PaymentService claims it atomically before calling
   * the provider). A `status: 'completed'` lookup then matches nothing, so the
   * SECOND partial return — the very sequence the telescoping allocator exists
   * for — threw 400 and could never be completed through the gateway.
   */
  it('finds the payment for a SECOND partial return, after the first left it partially_refunded', async () => {
    setup({
      returnedItems: [{ orderItemId: 'oi-a', quantity: 1 }],
      priorReturns: [{ items: [{ orderItemId: 'oi-a', quantity: 1 }] }],
      paymentStatus: 'partially_refunded',
      paymentRefunded: 1978,
    });

    await ReturnService.complete(STORE_ID, RETURN_ID, 'user-1', 'gateway');

    expect(providerRefund).toHaveBeenCalled();
    // The second unit's own share — never the first unit's money again.
    expect(refundedAmount()).toBeGreaterThan(1970);
    expect(refundedAmount()).toBeLessThan(1990);
  });

  /**
   * A full return following a partial must NOT pass an absent amount: absent
   * means the whole ORIGINAL payment to the provider, so the already-refunded
   * portion would go out a second time.
   */
  it('a FULL return after a prior partial refunds only the REMAINING balance', async () => {
    setup({
      returnedItems: [
        { orderItemId: 'oi-a', quantity: 2 },
        { orderItemId: 'oi-b', quantity: 1 },
      ],
      paymentStatus: 'partially_refunded',
      paymentRefunded: 1978,
    });

    await ReturnService.complete(STORE_ID, RETURN_ID, 'user-1', 'gateway');

    expect(refundedAmount()).toBe(PAYMENT_TOTAL - 1978);
    expect(refundedAmount()).not.toBeUndefined();
    // Still a full refund as far as PaymentService is concerned (it measures
    // against the remaining balance), so it owns the whole-order fanout.
    expect(applyRefundEffects).not.toHaveBeenCalled();
  });

  it('refuses the gateway when the payment is already refunded in full', async () => {
    setup({
      returnedItems: [{ orderItemId: 'oi-a', quantity: 1 }],
      paymentStatus: 'partially_refunded',
      paymentRefunded: PAYMENT_TOTAL,
    });

    await expect(ReturnService.complete(STORE_ID, RETURN_ID, 'user-1', 'gateway')).rejects.toThrow(
      /already been refunded in full/i
    );

    expect(providerRefund).not.toHaveBeenCalled();
  });

  it('does not call the provider at all for a manual refund method', async () => {
    setup({ returnedItems: [{ orderItemId: 'oi-a', quantity: 1 }] });

    await ReturnService.complete(STORE_ID, RETURN_ID, 'user-1', 'manual');

    expect(providerRefund).not.toHaveBeenCalled();
    // Item-level effects still run — a manual partial return must restock the
    // returned lines without reversing the whole order.
    const [, , opts] = applyRefundEffects.mock.calls[0] as [string, string, { partial?: unknown }];
    expect(opts?.partial).toBeTruthy();
  });
});

describe('ReturnService.complete — the completion claim', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.resetAllMocks();
  });

  /**
   * A merchant double-clicking "Complete" used to refund twice for real.
   * The status check is a read and the flip to 'completed' happens after the
   * provider round-trip, so both callers passed it. The widened payment lookup
   * had been masking this by accident — once the first refund flipped the
   * Payment to 'partially_refunded' the second call found no payment and 400'd
   * — and that accident disappeared when a partially-refunded payment became a
   * valid refund source. Gateway refunds are terminal with no undo API.
   */
  it('refuses to proceed when another caller already claimed the return', async () => {
    setup({ returnedItems: [{ orderItemId: 'oi-a', quantity: 1 }] });
    returnUpdateMany.mockResolvedValue({ count: 0 }); // lost the race

    await expect(ReturnService.complete(STORE_ID, RETURN_ID, 'user-1', 'gateway')).rejects.toThrow(
      /already being completed/i
    );

    expect(providerRefund, 'a lost race must never reach the gateway').not.toHaveBeenCalled();
    expect(applyRefundEffects).not.toHaveBeenCalled();
  });

  it('claims the return BEFORE calling the provider, not after', async () => {
    setup({ returnedItems: [{ orderItemId: 'oi-a', quantity: 1 }] });

    await ReturnService.complete(STORE_ID, RETURN_ID, 'user-1', 'gateway');

    expect(returnUpdateMany).toHaveBeenCalled();
    const claimOrder = returnUpdateMany.mock.invocationCallOrder[0];
    const refundOrder = providerRefund.mock.invocationCallOrder[0];
    expect(claimOrder).toBeLessThan(refundOrder);
    // And the claim is a compare-and-set on the un-completed statuses.
    const where = (returnUpdateMany.mock.calls[0]?.[0] as { where: Record<string, unknown> }).where;
    expect(where.refundedAt).toBeNull();
    expect(where.status).toEqual({ in: ['received', 'inspecting'] });
  });

  it('releases the claim when the provider refund fails, so the return is retryable', async () => {
    setup({ returnedItems: [{ orderItemId: 'oi-a', quantity: 1 }] });
    providerRefund.mockRejectedValueOnce(new Error('gateway timeout'));

    await expect(
      ReturnService.complete(STORE_ID, RETURN_ID, 'user-1', 'gateway')
    ).rejects.toThrow();

    // Second updateMany call is the release: refundedAt back to null.
    const release = returnUpdateMany.mock.calls.at(-1)?.[0] as {
      data: { refundedAt: unknown };
      where: Record<string, unknown>;
    };
    expect(release.data.refundedAt).toBeNull();
    expect(release.where.status).toEqual({ in: ['received', 'inspecting'] });
  });
});

describe('ReturnService.complete — piecewise returns on a zero-shipping order', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.resetAllMocks();
  });

  /**
   * The allocator telescopes: every return's cashCredit over an order sums to
   * exactly subtotal - discount + tax, while payment.amount is that plus
   * shipping. So before the LAST piece, refundableRemaining is
   * shipping + cashCredit_final — and a `>=` guard reduces to rejecting
   * whenever shipping <= 0. Order.shipping defaults to 0 and free delivery is
   * the norm here, so `>=` hard-blocked the second half of every two-line
   * piecewise return, telling the merchant to complete it as a full return —
   * which isFullReturn makes impossible for a Return covering one line.
   */
  it('allows the final piece when it exactly exhausts the remaining balance', async () => {
    setup({
      returnedItems: [{ orderItemId: 'oi-b', quantity: 1 }],
      priorReturns: [{ items: [{ orderItemId: 'oi-a', quantity: 2 }] }],
    });
    // Zero shipping: payment == subtotal - discount + tax, so the last piece
    // equals refundableRemaining exactly.
    paymentFindFirst.mockResolvedValue({
      id: 'pay-1',
      transactionId: 'txn-1',
      amount: 8900,
      // What the FIRST return (2 x 2000) actually allocated: 4000 gross, less
      // its 444 discount share, plus its 400 tax share = 3956. Remaining is
      // then 8900 - 3956 = 4944, which is EXACTLY this final piece — the
      // equality case the old `>=` rejected.
      refundedAmount: 3956,
      status: 'partially_refunded',
    });

    await expect(
      ReturnService.complete(STORE_ID, RETURN_ID, 'user-1', 'gateway')
    ).resolves.toBeTruthy();

    expect(providerRefund).toHaveBeenCalled();
    expect(refundedAmount()).toBeGreaterThan(0);

    // EXACTLY ONE fanout. This case exercised the equality path but used to
    // assert only that the provider was called, which is what let a double
    // dispatch through: PaymentService reads amount >= remaining as a FULL
    // refund and runs the whole-order effects itself, so firing the item-level
    // event here as well sent two order/refunded events guarding on different
    // idempotency markers — a race that restores the same units twice and
    // emails the customer two refund confirmations.
    expect(
      applyRefundEffects,
      'PaymentService already ran the whole-order effects for this amount — a second fanout double-restores'
    ).not.toHaveBeenCalled();
  });

  it('still fires exactly one ITEM-LEVEL fanout when the piece is below the remainder', async () => {
    setup({ returnedItems: [{ orderItemId: 'oi-a', quantity: 1 }] });

    await ReturnService.complete(STORE_ID, RETURN_ID, 'user-1', 'gateway');

    expect(applyRefundEffects).toHaveBeenCalledOnce();
    const [, , opts] = applyRefundEffects.mock.calls[0] as [string, string, { partial?: unknown }];
    expect(opts?.partial, 'below the remainder, the gateway ran NO effects').toBeTruthy();
  });

  it('still rejects a piece that exceeds what the payment has left', async () => {
    setup({ returnedItems: [{ orderItemId: 'oi-b', quantity: 1 }] });
    paymentFindFirst.mockResolvedValue({
      id: 'pay-1',
      transactionId: 'txn-1',
      amount: 8900,
      refundedAmount: 8800, // only 100 piastres left, the piece is worth far more
      status: 'partially_refunded',
    });

    await expect(ReturnService.complete(STORE_ID, RETURN_ID, 'user-1', 'gateway')).rejects.toThrow(
      /only 1\.00 EGP is left on the payment/i
    );

    expect(providerRefund).not.toHaveBeenCalled();
  });

  /**
   * #1403. The amount is derived and the merchant cannot edit it, and a
   * one-line return can never be completed as a full one — so the refusal is a
   * dead end unless it names the way out. It happens when money already left
   * the payment outside any return (a goodwill refund from the order page, a
   * refund in the provider's dashboard), which the allocator cannot see.
   */
  it('names the amounts and the way out when the payment has too little left', async () => {
    setup({ returnedItems: [{ orderItemId: 'oi-b', quantity: 1 }] });
    paymentFindFirst.mockResolvedValue({
      id: 'pay-1',
      transactionId: 'txn-1',
      amount: 8900,
      refundedAmount: 8800,
      status: 'partially_refunded',
    });

    const err = (await ReturnService.complete(STORE_ID, RETURN_ID, 'user-1', 'original').catch(
      e => e
    )) as AppError;

    expect(err.code).toBe('PARTIAL_REFUND_EXCEEDS_PAYMENT');
    expect(err.message).toMatch(/store credit or bank transfer/i);
    expect(err.message).toMatch(/49\.45 EGP/);
    expect(err.details).toEqual({ refundAmount: 4945, refundableRemaining: 100 });
    // A manual method is the stated way out, and it does complete.
    vi.resetAllMocks();
    setup({ returnedItems: [{ orderItemId: 'oi-b', quantity: 1 }] });
    await expect(
      ReturnService.complete(STORE_ID, RETURN_ID, 'user-1', 'bank_transfer')
    ).resolves.toBeTruthy();
  });
});

describe('ReturnService.complete — the claim is retained once money may have moved', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.resetAllMocks();
  });

  /**
   * Releasing the claim on ANY failure was wrong, and this is the case that
   * makes it wrong: the completion write is what closes the allocator's books,
   * so until it lands the retry recomputes the identical allocation (this
   * return is still excluded from prevQty by `id: { not: returnId }`) and the
   * payment still has room. A "retryable" return after a successful refund is
   * a second real refund, and there is no undo API at the gateway.
   *
   * So the claim is held and the merchant gets a 409 until a human reconciles
   * — a stranded return is recoverable by hand; a duplicate refund is not.
   */
  it('does NOT release when the refund succeeded and a later step threw', async () => {
    setup({ returnedItems: [{ orderItemId: 'oi-a', quantity: 1 }] });
    // Refund executes, then the completion write fails.
    returnUpdate.mockRejectedValueOnce(new Error('db write failed'));

    await expect(
      ReturnService.complete(STORE_ID, RETURN_ID, 'user-1', 'gateway')
    ).rejects.toThrow();

    expect(providerRefund).toHaveBeenCalledOnce();
    const releases = returnUpdateMany.mock.calls.filter(
      c => (c[0] as { data: { refundedAt: unknown } }).data.refundedAt === null
    );
    expect(releases, 'the claim must stay held once the money is out').toEqual([]);
  });

  /**
   * PaymentService says whether its request reached the provider (#1359,
   * #1431). The balance probe this replaced re-read `Payment.refundedAmount`,
   * which could not tell this return's refund from a concurrent one, and which
   * PaymentService used to reset on a timeout — the one failure where the
   * refund most likely DID go out.
   */
  it('treats a refund throw as EXECUTED when PaymentService says the money may have moved', async () => {
    setup({ returnedItems: [{ orderItemId: 'oi-a', quantity: 1 }] });
    providerRefund.mockRejectedValueOnce(
      markRefundMayHaveExecuted(new Error('post-refund tx failed'))
    );

    await expect(ReturnService.complete(STORE_ID, RETURN_ID, 'user-1', 'gateway')).rejects.toThrow(
      /do not refund it again/i
    );

    const releases = returnUpdateMany.mock.calls.filter(
      c => (c[0] as { data: { refundedAt: unknown } }).data.refundedAt === null
    );
    expect(releases, 'money may have moved — the claim must not be released').toEqual([]);
  });

  it('releases when PaymentService says nothing was sent', async () => {
    setup({ returnedItems: [{ orderItemId: 'oi-a', quantity: 1 }] });
    providerRefund.mockRejectedValueOnce(new Error('provider refused'));

    await expect(ReturnService.complete(STORE_ID, RETURN_ID, 'user-1', 'gateway')).rejects.toThrow(
      /retry or switch refund method/i
    );

    const releases = returnUpdateMany.mock.calls.filter(
      c => (c[0] as { data: { refundedAt: unknown } }).data.refundedAt === null
    );
    expect(releases.length, 'no money moved — the return must stay retryable').toBe(1);
  });

  /**
   * #1431. Two returns on one order completing together: the loser fails
   * PaymentService's compare-and-swap BEFORE any provider call, while the
   * winner has already raised the balance. The old probe read that raised
   * balance as "my refund executed", kept the claim and told the merchant not
   * to retry — a return stranded for a request where nothing went wrong.
   */
  it('a concurrent refund raising the balance does not strand this return', async () => {
    setup({ returnedItems: [{ orderItemId: 'oi-a', quantity: 1 }] });
    providerRefund.mockRejectedValueOnce(
      new AppError(
        400,
        'INVALID_STATE',
        'Payment is not refundable or a refund is already in progress'
      )
    );
    // What the old probe would have read: the WINNER's refund.
    paymentFindFirst
      .mockResolvedValueOnce({
        id: 'pay-1',
        transactionId: 'txn-1',
        amount: PAYMENT_TOTAL,
        refundedAmount: 0,
        status: 'completed',
      })
      .mockResolvedValue({
        id: 'pay-1',
        transactionId: 'txn-1',
        amount: PAYMENT_TOTAL,
        refundedAmount: 3956,
        status: 'partially_refunded',
      });

    const err = (await ReturnService.complete(STORE_ID, RETURN_ID, 'user-1', 'gateway').catch(
      e => e
    )) as AppError;

    expect(err.code, 'a refusal before the provider is passed through, not "do not retry"').toBe(
      'INVALID_STATE'
    );
    const releases = returnUpdateMany.mock.calls.filter(
      c => (c[0] as { data: { refundedAt: unknown } }).data.refundedAt === null
    );
    expect(releases.length).toBe(1);
  });

  it('passes a refund already issued for this return through, so the merchant can record it', async () => {
    setup({ returnedItems: [{ orderItemId: 'oi-a', quantity: 1 }] });
    providerRefund.mockRejectedValueOnce(
      new AppError(409, 'REFUND_ALREADY_ISSUED', 'A refund for this was already sent')
    );

    await expect(
      ReturnService.complete(STORE_ID, RETURN_ID, 'user-1', 'original')
    ).rejects.toMatchObject({ code: 'REFUND_ALREADY_ISSUED', statusCode: 409 });
  });
});

describe('ReturnService.complete — one refund per return, one completion per order', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.resetAllMocks();
  });

  /**
   * A refund for this return already went out; its completion then failed and
   * the request rolled back, so the return is 'received' again. Every other
   * check would now give a misleading reason (the balance is short BECAUSE of
   * that refund), and a retry would pay twice.
   */
  it('refuses the gateway, before any amount check, when this return already sent a refund', async () => {
    setup({ returnedItems: [{ orderItemId: 'oi-a', quantity: 1 }] });
    findOutstandingRefundClaims.mockResolvedValue(['claim-earlier']);

    await expect(
      ReturnService.complete(STORE_ID, RETURN_ID, 'user-1', 'original')
    ).rejects.toMatchObject({ code: 'REFUND_ALREADY_ISSUED' });

    expect(providerRefund, 'the customer must not be paid twice').not.toHaveBeenCalled();
    expect(findOutstandingRefundClaims).toHaveBeenCalledWith(
      'pay-1',
      `return:${RETURN_ID}`,
      STORE_ID
    );
    // A manual method records it without touching the gateway.
    await expect(
      ReturnService.complete(STORE_ID, RETURN_ID, 'user-1', 'manual')
    ).resolves.toBeTruthy();
    expect(providerRefund).not.toHaveBeenCalled();
  });

  it('keys the gateway refund to this return, so a retry after a rollback is refused', async () => {
    setup({ returnedItems: [{ orderItemId: 'oi-a', quantity: 1 }] });

    await ReturnService.complete(STORE_ID, RETURN_ID, 'user-1', 'original');

    const req = providerRefund.mock.calls[0]?.[0] as { refundKey?: string };
    expect(req.refundKey).toBe(`return:${RETURN_ID}`);
  });

  // #1393 (two DIFFERENT returns of one order completing together) is serialised by the StoreDO now, not by a Postgres
  // advisory lock (Ruling NZ-REFUND-LOCK-1): apps/api/workers-do/returns.test.ts 'two different returns of one order
  // completing together: one wins, the other is RETURN_ORDER_BUSY'.
});

describe('ReturnService.complete — the payment balance is not the order', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.resetAllMocks();
  });

  /**
   * #1402. A 3500-fil goodwill refund from the order page leaves exactly line
   * A's share on the payment. Returning line A then "uses up" the payment, and
   * PaymentService used to read that as a whole-order refund: order flipped to
   * refunded, line B's stock restored while the customer still holds it,
   * coupon, affiliate and loyalty reversed, whole sale journal reversed.
   */
  it('flags a partial return that leaves lines with the customer as item-level', async () => {
    setup({ returnedItems: [{ orderItemId: 'oi-a', quantity: 1 }] });
    paymentFindFirst.mockResolvedValue({
      id: 'pay-1',
      transactionId: 'txn-1',
      amount: PAYMENT_TOTAL,
      refundedAmount: PAYMENT_TOTAL - 1978, // only this line's share is left
      status: 'partially_refunded',
    });

    await ReturnService.complete(STORE_ID, RETURN_ID, 'user-1', 'original');

    const req = providerRefund.mock.calls[0]?.[0] as { amount?: number; itemLevel?: boolean };
    expect(req.amount).toBe(1978);
    expect(req.itemLevel, 'lines remain — the order must not be reversed').toBe(true);
    // PaymentService ran no whole-order effects, so the return fires its own.
    const [, , opts] = applyRefundEffects.mock.calls[0] as [string, string, { partial?: unknown }];
    expect(opts?.partial).toBeTruthy();
  });

  it('the final piece, with every line now back, is not item-level', async () => {
    setup({
      returnedItems: [{ orderItemId: 'oi-b', quantity: 1 }],
      priorReturns: [{ items: [{ orderItemId: 'oi-a', quantity: 2 }] }],
    });

    await ReturnService.complete(STORE_ID, RETURN_ID, 'user-1', 'original');

    const req = providerRefund.mock.calls[0]?.[0] as { itemLevel?: boolean };
    expect(req.itemLevel).toBe(false);
  });

  /**
   * #1473. The decision to skip the local event is PaymentService's own
   * answer, never re-derived from the payment row read before the call. Here
   * the pre-call read says the piece exhausts the payment, but a webhook moved
   * the balance in between and PaymentService took the partial branch — so the
   * return must still fire its item-level event, or nothing restocks the line.
   */
  it("follows PaymentService's own answer, not a re-derivation from a stale read", async () => {
    setup({
      returnedItems: [{ orderItemId: 'oi-b', quantity: 1 }],
      priorReturns: [{ items: [{ orderItemId: 'oi-a', quantity: 2 }] }],
    });
    paymentFindFirst.mockResolvedValue({
      id: 'pay-1',
      transactionId: 'txn-1',
      amount: 8900,
      refundedAmount: 3956, // remaining 4944 == this piece, as read BEFORE the call
      status: 'partially_refunded',
    });
    providerRefund.mockResolvedValueOnce({
      success: true,
      refundId: 'rf-1',
      wholeOrderEffectsApplied: false,
    });

    await ReturnService.complete(STORE_ID, RETURN_ID, 'user-1', 'original');

    expect(applyRefundEffects).toHaveBeenCalledOnce();
    const [, , opts] = applyRefundEffects.mock.calls[0] as [string, string, { partial?: unknown }];
    expect(opts?.partial).toBeTruthy();
  });
});

describe('ReturnService.complete — a manual partial return records the NET amount (#1340)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.resetAllMocks();
  });

  /**
   * The journal books 1978 for this line (2000 − 222 discount share + 200
   * tax share). Keeping the creation-time gross 2000 on a manual or
   * store-credit completion showed the merchant — and emailed the customer —
   * a figure the ledger never matched.
   */
  it.each(['store_credit', 'bank_transfer', 'manual', 'cash'])(
    '%s writes and announces the net allocation, not the gross estimate',
    async method => {
      setup({ returnedItems: [{ orderItemId: 'oi-a', quantity: 1 }] });

      await ReturnService.complete(STORE_ID, RETURN_ID, 'user-1', method);

      const data = (returnUpdate.mock.calls[0]?.[0] as { data: { refundAmount?: number } }).data;
      expect(data.refundAmount).toBe(1978);
      const [, , opts] = applyRefundEffects.mock.calls[0] as [
        string,
        string,
        { partial?: { refundAmount?: number } },
      ];
      expect(opts.partial?.refundAmount).toBe(1978);
      expect(providerRefund).not.toHaveBeenCalled();
    }
  );

  it('refuses a manual partial return whose lines were all returned already', async () => {
    setup({
      returnedItems: [{ orderItemId: 'oi-a', quantity: 2 }],
      priorReturns: [{ items: [{ orderItemId: 'oi-a', quantity: 2 }] }],
    });

    await expect(
      ReturnService.complete(STORE_ID, RETURN_ID, 'user-1', 'bank_transfer')
    ).rejects.toMatchObject({ code: 'PARTIAL_REFUND_NOTHING_TO_REFUND' });
    expect(applyRefundEffects).not.toHaveBeenCalled();
  });

  it('a full manual return keeps its recorded figure (nothing here decides it)', async () => {
    setup({
      returnedItems: [
        { orderItemId: 'oi-a', quantity: 2 },
        { orderItemId: 'oi-b', quantity: 1 },
      ],
    });

    await ReturnService.complete(STORE_ID, RETURN_ID, 'user-1', 'bank_transfer');

    const data = (returnUpdate.mock.calls[0]?.[0] as { data: { refundAmount?: number } }).data;
    expect(data.refundAmount).toBeUndefined();
    expect(applyRefundEffects).toHaveBeenCalledWith(STORE_ID, ORDER_ID);
  });
});

describe("the admin's own refund methods reach the branch they mean", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.resetAllMocks();
  });

  /**
   * Every other test in this file passes the literal 'gateway'. That string is
   * produced NOWHERE in apps/ — the admin returns modal offers 'original',
   * 'store_credit' and 'bank_transfer', and the service matched only 'gateway'
   * and 'original_payment'. So the gateway branch was unreachable in
   * production while this suite reported it green: no provider refund was ever
   * issued from the returns page, the customer's card was never credited, the
   * refund email quoted the creation-time GROSS estimate, and the journal
   * booked the NET allocation. Three numbers, one of them zero.
   *
   * This reads the admin component's own list rather than repeating it, so the
   * two cannot drift again silently.
   */
  const modal = readFileSync(
    path.resolve(
      __dirname,
      '../../apps/admin/src/app/stores/[id]/returns/_components/RefundMethodModal.tsx'
    ),
    'utf8'
  );
  const adminMethods = [
    ...(modal.match(/const REFUND_METHODS: RefundMethod\[\] = \[([^\]]*)\]/)?.[1] ?? '').matchAll(
      /'([^']+)'/g
    ),
  ].map(m => m[1]);

  it('the admin offers a non-empty set of methods (guards the extraction)', () => {
    expect(
      adminMethods.length,
      'RefundMethodModal shape changed — re-point this test'
    ).toBeGreaterThan(0);
  });

  it("the admin's default 'original' triggers a REAL provider refund", async () => {
    expect(adminMethods).toContain('original');
    setup({ returnedItems: [{ orderItemId: 'oi-a', quantity: 1 }] });

    await ReturnService.complete(STORE_ID, RETURN_ID, 'user-1', 'original');

    expect(
      providerRefund,
      "'original' means Original payment method — it must reach the gateway, not the manual branch"
    ).toHaveBeenCalledOnce();
    expect(refundedAmount()).toBe(1978);
  });

  it('every admin method is accepted by the service contract', async () => {
    const { REFUND_METHODS } = await import('@api/services/return.service');
    for (const m of adminMethods) {
      expect(
        (REFUND_METHODS as readonly string[]).includes(m),
        `the admin can send '${m}' but the API rejects it`
      ).toBe(true);
    }
  });

  it('the non-gateway admin methods still take the manual branch', async () => {
    for (const m of adminMethods.filter(x => x !== 'original')) {
      vi.resetAllMocks();
      setup({ returnedItems: [{ orderItemId: 'oi-a', quantity: 1 }] });
      await ReturnService.complete(STORE_ID, RETURN_ID, 'user-1', m);
      expect(providerRefund, `'${m}' must NOT hit the gateway`).not.toHaveBeenCalled();
    }
  });
});

describe('an exchange never moves money', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.resetAllMocks();
  });

  /**
   * An exchange swaps goods; the customer is not refunded. That is why
   * `isInventoryRestoring` excludes it and why none of the downstream effects
   * fire for it.
   *
   * The gateway branch was gated only on the refund METHOD, never on the return
   * type — harmless while it was unreachable, live the moment the admin's own
   * 'original' joined the gateway set. A partial exchange completed that way
   * executed a real, irreversible provider refund while the side-effect
   * dispatch stayed silent: no GL adjustment, no restock, no refund email.
   * Revenue, tax and COGS stayed booked against cash that had left the gateway,
   * and the trial balance still balanced, so nothing surfaced it.
   */
  it.each(['original', 'gateway', 'original_payment'])(
    'refuses %s on an exchange, before the provider is called',
    async method => {
      setup({ returnedItems: [{ orderItemId: 'oi-a', quantity: 1 }] });
      getById.mockResolvedValue({
        id: RETURN_ID,
        status: 'received',
        type: 'exchange',
        orderId: ORDER_ID,
        refundAmount: 2000,
        items: [{ orderItemId: 'oi-a', quantity: 1 }],
      });

      await expect(ReturnService.complete(STORE_ID, RETURN_ID, 'user-1', method)).rejects.toThrow(
        /exchange swaps goods/i
      );

      expect(providerRefund, 'no money may leave for an exchange').not.toHaveBeenCalled();
      expect(applyRefundEffects).not.toHaveBeenCalled();
    }
  );

  it('still allows a non-gateway method on an exchange', async () => {
    setup({ returnedItems: [{ orderItemId: 'oi-a', quantity: 1 }] });
    getById.mockResolvedValue({
      id: RETURN_ID,
      status: 'received',
      type: 'exchange',
      orderId: ORDER_ID,
      refundAmount: 2000,
      items: [{ orderItemId: 'oi-a', quantity: 1 }],
    });

    await expect(
      ReturnService.complete(STORE_ID, RETURN_ID, 'user-1', 'store_credit')
    ).resolves.toBeTruthy();
    expect(providerRefund).not.toHaveBeenCalled();
  });

  it('a refund-type return with the same method still reaches the gateway', async () => {
    // Guards against over-broad rejection: only `exchange` is refused.
    setup({ returnedItems: [{ orderItemId: 'oi-a', quantity: 1 }] });

    await ReturnService.complete(STORE_ID, RETURN_ID, 'user-1', 'original');

    expect(providerRefund).toHaveBeenCalledOnce();
  });
});

describe('a COD order cannot refund at the gateway', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.resetAllMocks();
  });

  /**
   * COD payments reach `status: 'completed'` with a NULL transactionId — they
   * are created without one and the mark-COD-paid route never sets one. The
   * returns lookup filtered only on orderId and status, then asserted
   * `payment.transactionId!` — a claim the schema does not support, since the
   * column is `String?`.
   *
   * That null reached PaymentService.refund, whose lookup is
   * `findFirst({ where: { transactionId } })`. Prisma DROPS undefined filters,
   * so the WHERE became EMPTY and returned an ARBITRARY payment row in the
   * tenant. Everything downstream then ran against the wrong order: the claim
   * wrote its status and refundedAmount, the transition guard checked its
   * status, and a successful provider call flipped THAT order to refunded,
   * restored its inventory, reversed its GL and emailed "Refund issued" to a
   * customer who had returned nothing.
   *
   * Dead while the gateway branch was unreachable; live the moment the admin's
   * 'original' joined the gateway set — and COD is the dominant method here.
   */
  it('refuses a gateway refund when the payment has no provider transaction', async () => {
    setup({ returnedItems: [{ orderItemId: 'oi-a', quantity: 1 }] });
    // The filter excludes it, so the lookup finds nothing.
    paymentFindFirst.mockResolvedValue(null);

    await expect(ReturnService.complete(STORE_ID, RETURN_ID, 'user-1', 'original')).rejects.toThrow(
      /cash-on-delivery|no refundable payment/i
    );

    expect(providerRefund, 'no provider call may be attempted').not.toHaveBeenCalled();
  });

  it('the lookup itself excludes transaction-less payments', async () => {
    setup({ returnedItems: [{ orderItemId: 'oi-a', quantity: 1 }] });
    paymentFindFirst.mockResolvedValue(null);

    await ReturnService.complete(STORE_ID, RETURN_ID, 'user-1', 'original').catch(() => {});

    const where = (paymentFindFirst.mock.calls[0]?.[0] as { where: Record<string, unknown> }).where;
    expect(
      where.transactionId,
      'without this filter a COD payment is selected and refunded against nothing'
    ).toEqual({ not: null });
  });

  it('still refunds normally when a transaction id is present', async () => {
    setup({ returnedItems: [{ orderItemId: 'oi-a', quantity: 1 }] });

    await ReturnService.complete(STORE_ID, RETURN_ID, 'user-1', 'original');

    expect(providerRefund).toHaveBeenCalledOnce();
    const arg = providerRefund.mock.calls[0]?.[0] as { transactionId?: string };
    expect(arg.transactionId).toBe('txn-1');
  });
});

describe('ReturnService.refundPreview — what the admin confirms is what complete() sends', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.resetAllMocks();
  });

  it('a partial return: the net allocation, on both the gateway and manual paths', async () => {
    setup({ returnedItems: [{ orderItemId: 'oi-a', quantity: 1 }] });

    const preview = await ReturnService.refundPreview(STORE_ID, RETURN_ID);

    expect(preview.recordedAmount).toBe(1978);
    expect(preview.gateway).toEqual({
      available: true,
      amount: 1978,
      // Not a wallet-paid order: nothing of it goes back to the wallet (#1956).
      walletShare: 0,
      refundableRemaining: PAYMENT_TOTAL,
      unavailableReason: null,
      alreadyPaidToCustomer: false,
    });
    // And complete() sends exactly that.
    await ReturnService.complete(STORE_ID, RETURN_ID, 'user-1', 'original');
    expect(refundedAmount()).toBe(preview.gateway.amount);
  });

  it('a full return: the whole remaining payment, not the gross line estimate', async () => {
    setup({
      returnedItems: [
        { orderItemId: 'oi-a', quantity: 2 },
        { orderItemId: 'oi-b', quantity: 1 },
      ],
    });

    const preview = await ReturnService.refundPreview(STORE_ID, RETURN_ID);

    expect(preview.gateway.amount).toBe(PAYMENT_TOTAL);
  });

  it('a COD order: the gateway is unavailable, and says why', async () => {
    setup({ returnedItems: [{ orderItemId: 'oi-a', quantity: 1 }] });
    paymentFindFirst.mockResolvedValue(null);

    const preview = await ReturnService.refundPreview(STORE_ID, RETURN_ID);

    expect(preview.gateway.available).toBe(false);
    expect(preview.gateway.unavailableReason).toBe('NO_COMPLETED_PAYMENT');
    expect(providerRefund, 'a preview never moves money').not.toHaveBeenCalled();
  });

  it('an exchange: never the gateway', async () => {
    setup({ returnedItems: [{ orderItemId: 'oi-a', quantity: 1 }] });
    getById.mockResolvedValue({
      id: RETURN_ID,
      status: 'received',
      type: 'exchange',
      orderId: ORDER_ID,
      refundAmount: 2000,
      items: [{ orderItemId: 'oi-a', quantity: 1 }],
    });

    const preview = await ReturnService.refundPreview(STORE_ID, RETURN_ID);

    expect(preview.gateway.unavailableReason).toBe('EXCHANGE_CANNOT_REFUND_TO_GATEWAY');
  });

  it('a refund already sent for this return: unavailable, with that reason', async () => {
    setup({ returnedItems: [{ orderItemId: 'oi-a', quantity: 1 }] });
    findOutstandingRefundClaims.mockResolvedValue(['c1']);

    const preview = await ReturnService.refundPreview(STORE_ID, RETURN_ID);

    expect(preview.gateway.unavailableReason).toBe('REFUND_ALREADY_ISSUED');
    expect(preview.gateway.alreadyPaidToCustomer).toBe(true);
  });

  it('issue 2003 — a payment already refunded in full elsewhere: record-only is honest', async () => {
    setup({ returnedItems: [{ orderItemId: 'oi-a', quantity: 1 }] });
    paymentFindFirst.mockResolvedValue({
      id: 'pay-1',
      amount: PAYMENT_TOTAL,
      refundedAmount: PAYMENT_TOTAL,
      status: 'refunded',
      transactionId: 'tx-1',
      provider: 'kashier',
    });

    const preview = await ReturnService.refundPreview(STORE_ID, RETURN_ID);

    expect(preview.gateway.unavailableReason).toBe('PAYMENT_FULLY_REFUNDED');
    expect(preview.gateway.alreadyPaidToCustomer).toBe(true);
  });

  it('issue 2003 — a COD order is NOT already paid to the customer', async () => {
    setup({ returnedItems: [{ orderItemId: 'oi-a', quantity: 1 }] });
    paymentFindFirst.mockResolvedValue(null);
    const preview = await ReturnService.refundPreview(STORE_ID, RETURN_ID);
    expect(preview.gateway.alreadyPaidToCustomer).toBe(false);
  });

  it('wallet OFF: no wallet figure — store credit keeps its off-platform meaning', async () => {
    setup({ returnedItems: [{ orderItemId: 'oi-a', quantity: 1 }] });

    const preview = await ReturnService.refundPreview(STORE_ID, RETURN_ID);

    expect(preview.storeCreditToWallet).toBeNull();
  });

  it('wallet ON: previews the figure complete() credits (full return adds shipping, nets out the wallet-paid part)', async () => {
    setup({
      returnedItems: [
        { orderItemId: 'oi-a', quantity: 2 },
        { orderItemId: 'oi-b', quantity: 1 },
      ],
    });
    orderFindFirst.mockResolvedValue({
      subtotal: 9000,
      discount: 1000,
      tax: 900,
      shipping: 500,
      walletAmount: 2000,
    });
    const { featureService } = await import('@api/services/feature.service');
    vi.mocked(featureService.isFeatureEnabled).mockResolvedValue(true);

    const preview = await ReturnService.refundPreview(STORE_ID, RETURN_ID);

    // 8900 net + 500 shipping − 2000 already paid from the wallet (returned by
    // the order/refunded fanout, not by this credit).
    expect(preview.storeCreditToWallet).toBe(7400);
    // The off-platform figure is unchanged, and is NOT what the wallet gets.
    expect(preview.recordedAmount).toBe(9000);
  });

  it('wallet ON, partial return: the wallet figure is the same net allocation', async () => {
    setup({ returnedItems: [{ orderItemId: 'oi-a', quantity: 1 }] });
    const { featureService } = await import('@api/services/feature.service');
    vi.mocked(featureService.isFeatureEnabled).mockResolvedValue(true);

    const preview = await ReturnService.refundPreview(STORE_ID, RETURN_ID);

    expect(preview.storeCreditToWallet).toBe(1978);
    expect(preview.storeCreditToWallet).toBe(preview.recordedAmount);
  });
});

/**
 * issue 2002 — a NON-gateway completion settles the return's open refund
 * claims (so the stuck-claim sweep stops alerting); a gateway completion never
 * does (its own refund resolves its claim). Mutation-proof: dropping the
 * reconcile call (or running it for gateway methods) reddens this.
 */
describe('ReturnService.complete — record-only settles open refund claims (issue 2002)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.resetAllMocks();
    setup({ returnedItems: [{ orderItemId: 'oi-a', quantity: 1 }] });
  });

  it('settles claims for a manual completion, keyed on this return', async () => {
    await ReturnService.complete(STORE_ID, RETURN_ID, 'admin-1', 'manual');
    expect(reconcileOutstandingRefundClaims).toHaveBeenCalledWith(
      expect.objectContaining({
        storeId: STORE_ID,
        refundKey: `return:${RETURN_ID}`,
        refundMethod: 'manual',
        userId: 'admin-1',
      })
    );
  });

  it('never settles claims on a gateway completion', async () => {
    await ReturnService.complete(STORE_ID, RETURN_ID, 'admin-1', 'original');
    expect(reconcileOutstandingRefundClaims).not.toHaveBeenCalled();
  });
});
