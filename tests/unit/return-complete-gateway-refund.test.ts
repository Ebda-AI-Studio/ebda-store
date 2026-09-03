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

vi.mock('@force/database', () => ({
  prisma: {
    return: {
      update: (...a: unknown[]) => returnUpdate(...a),
      updateMany: (...a: unknown[]) => returnUpdateMany(...a),
      findMany: (...a: unknown[]) => returnFindMany(...a),
    },
    order: { findFirst: (...a: unknown[]) => orderFindFirst(...a) },
    orderItem: { findMany: (...a: unknown[]) => orderItemFindMany(...a) },
    payment: { findFirst: (...a: unknown[]) => paymentFindFirst(...a) },
  },
  Prisma: {},
  ReturnStatus: {},
  ReturnType: {},
}));

vi.mock('@api/services/payment-providers/payment.factory', () => ({
  PaymentService: { refund: (...a: unknown[]) => providerRefund(...a) },
}));
vi.mock('@api/services/order.service', () => ({
  OrderService: { applyRefundEffects: (...a: unknown[]) => applyRefundEffects(...a) },
}));
vi.mock('@api/services/email.service', () => ({ EmailService: {} }));
vi.mock('@api/services/socket.service', () => ({ socketService: { emitToStore: vi.fn() } }));
vi.mock('@api/lib/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { ReturnService } from '@api/services/return.service';

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
  providerRefund.mockResolvedValue({ success: true, refundId: 'rf-1' });
  applyRefundEffects.mockResolvedValue(undefined);
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
      refundedAmount: 8800, // only 100 fils left, the piece is worth far more
      status: 'partially_refunded',
    });

    await expect(ReturnService.complete(STORE_ID, RETURN_ID, 'user-1', 'gateway')).rejects.toThrow(
      /more than the payment has left/i
    );

    expect(providerRefund).not.toHaveBeenCalled();
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
   * a second real refund, and there is no undo API at Tap/MyFatoorah/KNET.
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
   * A throw from PaymentService.refund does NOT prove no money moved: it
   * commits its own claim (status + refundedAmount) BEFORE the provider
   * round-trip and only unwinds it when the provider call itself threw. If its
   * post-provider transaction fails it rethrows with the real refund standing.
   * So the Payment row is the evidence, not the exception.
   */
  it('treats a refund throw as EXECUTED when the payment balance moved', async () => {
    setup({ returnedItems: [{ orderItemId: 'oi-a', quantity: 1 }] });
    providerRefund.mockRejectedValueOnce(new Error('post-refund tx failed'));
    // Re-read shows the balance advanced: the refund really happened.
    paymentFindFirst
      .mockResolvedValueOnce({
        id: 'pay-1',
        transactionId: 'txn-1',
        amount: PAYMENT_TOTAL,
        refundedAmount: 0,
        status: 'completed',
      })
      .mockResolvedValueOnce({ refundedAmount: 1978 });

    await expect(ReturnService.complete(STORE_ID, RETURN_ID, 'user-1', 'gateway')).rejects.toThrow(
      /do not retry/i
    );

    const releases = returnUpdateMany.mock.calls.filter(
      c => (c[0] as { data: { refundedAt: unknown } }).data.refundedAt === null
    );
    expect(releases, 'money moved — the claim must be retained').toEqual([]);
  });

  it('releases when the refund threw and the payment balance did NOT move', async () => {
    setup({ returnedItems: [{ orderItemId: 'oi-a', quantity: 1 }] });
    providerRefund.mockRejectedValueOnce(new Error('connection refused'));
    paymentFindFirst
      .mockResolvedValueOnce({
        id: 'pay-1',
        transactionId: 'txn-1',
        amount: PAYMENT_TOTAL,
        refundedAmount: 0,
        status: 'completed',
      })
      .mockResolvedValueOnce({ refundedAmount: 0 }); // untouched

    await expect(ReturnService.complete(STORE_ID, RETURN_ID, 'user-1', 'gateway')).rejects.toThrow(
      /retry or switch refund method/i
    );

    const releases = returnUpdateMany.mock.calls.filter(
      c => (c[0] as { data: { refundedAt: unknown } }).data.refundedAt === null
    );
    expect(releases.length, 'no money moved — the return must stay retryable').toBe(1);
  });

  it('assumes the worst when the payment row cannot be re-read', async () => {
    setup({ returnedItems: [{ orderItemId: 'oi-a', quantity: 1 }] });
    providerRefund.mockRejectedValueOnce(new Error('timeout'));
    paymentFindFirst
      .mockResolvedValueOnce({
        id: 'pay-1',
        transactionId: 'txn-1',
        amount: PAYMENT_TOTAL,
        refundedAmount: 0,
        status: 'completed',
      })
      .mockRejectedValueOnce(new Error('db unreachable'));

    await expect(ReturnService.complete(STORE_ID, RETURN_ID, 'user-1', 'gateway')).rejects.toThrow(
      /do not retry/i
    );

    const releases = returnUpdateMany.mock.calls.filter(
      c => (c[0] as { data: { refundedAt: unknown } }).data.refundedAt === null
    );
    expect(releases, 'unknown state must bias to stranding, not double-refunding').toEqual([]);
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
