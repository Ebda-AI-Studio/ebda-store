/**
 * The one rule that decides whether a refund settles a payment.
 *
 * It used to be written twice — once in the refund-webhook branch, once in the
 * refresh-refund-status route — and the two copies diverged twice in a single
 * evening, in opposite directions:
 *
 *  1. The whole-order effects gate went into the route and not the webhook, so
 *     a PARTIAL out-of-band refund still restored all inventory and reversed
 *     the entire sale journal.
 *  2. The unknown-amount rule then went into the webhook and not the route, so
 *     an amount-less provider response was recorded as a 0-fil PARTIAL refund:
 *     every reversal suppressed while the money had already left the gateway,
 *     and the payment left looking refundable so a later return could fire a
 *     SECOND real refund.
 *
 * Both directions are pinned here so the third divergence cannot happen
 * quietly.
 */

import { describe, it, expect } from 'vitest';
import {
  resolveRefundSettlement,
  readAccountedRefundEventIds,
  appendRefundEventId,
  isRefundEventAlreadySeen,
  recordRefundStatus,
  readRefundStatusById,
} from '@api/services/payment-providers/refund-settlement';

const PAYMENT = 5000;

function settle(reported: Array<number | null | undefined>, alreadyRefunded = 0) {
  return resolveRefundSettlement({ paymentAmount: PAYMENT, alreadyRefunded, reported });
}

describe('resolveRefundSettlement', () => {
  describe('an unreported amount means FULL, never a zero-fil partial', () => {
    it.each([
      ['absent', [undefined]],
      ['null', [null]],
      ['zero', [0]],
      ['negative', [-1]],
      ['NaN', [Number.NaN]],
      ['Infinity', [Number.POSITIVE_INFINITY]],
      ['all candidates unusable', [null, undefined, 0]],
    ])('%s → full refund', (_label, reported) => {
      const r = settle(reported as Array<number | null | undefined>);
      expect(r.isFullRefund, 'absence is not evidence of a partial refund').toBe(true);
      expect(r.reportedAmount).toBeNull();
      // ...and the budget records the payment, not 0 — otherwise the payment
      // still looks refundable and a later return fires a second real refund.
      expect(r.settledTotal).toBe(PAYMENT);
    });
  });

  describe('a reported amount that falls short is a genuine partial', () => {
    it('2000 of 5000 → partial, budget 2000', () => {
      const r = settle([2000]);
      expect(r.isFullRefund).toBe(false);
      expect(r.settledTotal).toBe(2000);
    });

    it('takes the first usable candidate, in preference order', () => {
      expect(settle([null, 2000, 4000]).settledTotal).toBe(2000);
      expect(settle([0, 3000]).settledTotal).toBe(3000);
    });

    it('reaching the payment exactly settles it', () => {
      const r = settle([PAYMENT]);
      expect(r.isFullRefund).toBe(true);
      expect(r.settledTotal).toBe(PAYMENT);
    });

    it('over-reporting cannot exceed... it simply settles', () => {
      const r = settle([PAYMENT + 1000]);
      expect(r.isFullRefund).toBe(true);
      expect(r.settledTotal).toBe(PAYMENT + 1000);
    });
  });

  describe('the cumulative total never decreases', () => {
    it('keeps an in-band total already recorded by the atomic claim', () => {
      // 3000 already accounted; this webhook reports its own 2000 slice.
      const r = settle([2000], 3000);
      expect(r.settledTotal, 'writing 2000 would erase 1000 of real refunds').toBe(3000);
      expect(r.isFullRefund).toBe(false);
    });

    it('raises the total for an out-of-band refund nothing had accounted', () => {
      expect(settle([2000], 0).settledTotal).toBe(2000);
    });

    it('settles once the accumulated total reaches the payment', () => {
      const r = settle([2000], PAYMENT);
      expect(r.isFullRefund).toBe(true);
      expect(r.settledTotal).toBe(PAYMENT);
    });
  });

  describe('an already-accounted refund is not settled by a vague event', () => {
    // MyFatoorah executes refunds asynchronously, so EVERY in-band partial
    // return gets a RefundStatusChanged webhook after PaymentService.refund
    // has already claimed its slice. That payload carries either no refund
    // amount at all or `RefundAmount ?? Amount` — the WHOLE invoice. Read as
    // full, it marks the payment settled at its full amount: refundable
    // remaining goes to 0, every later partial return dies with
    // PAYMENT_FULLY_REFUNDED, and refund reporting overstates the difference.
    it('an unreported amount does not settle a partially-refunded payment', () => {
      const r = settle([0], 1978);
      expect(r.isFullRefund, 'the settle notice for the 1978 slice, not a new refund').toBe(false);
      expect(r.settledTotal).toBe(1978);
    });

    it('an echoed invoice-sized amount does not settle it either', () => {
      const r = settle([PAYMENT], 1978);
      expect(r.isFullRefund).toBe(false);
      expect(r.settledTotal).toBe(1978);
    });

    it('a short reported amount is still credible and still raises the total', () => {
      const r = settle([3000], 1978);
      expect(r.isFullRefund).toBe(false);
      expect(r.settledTotal).toBe(3000);
    });

    it('with nothing accounted, unknown still means FULL', () => {
      expect(settle([0], 0).isFullRefund).toBe(true);
      expect(settle([PAYMENT], 0).isFullRefund).toBe(true);
    });
  });

  describe('degenerate payments', () => {
    it('a payment with no positive total cannot be partially refunded', () => {
      const r = resolveRefundSettlement({
        paymentAmount: 0,
        alreadyRefunded: 0,
        reported: [1000],
      });
      expect(r.isFullRefund).toBe(true);
    });

    it('never returns a negative settled total', () => {
      const r = resolveRefundSettlement({
        paymentAmount: -100,
        alreadyRefunded: null,
        reported: [null],
      });
      expect(r.settledTotal).toBeGreaterThanOrEqual(0);
    });
  });
});

describe('two distinct refunds accumulate; the same one never counts twice', () => {
  // The defect: providers report the amount of THIS refund, never a running
  // total, so taking the larger of the two discarded the smaller. A payment
  // whose gateway had returned everything still showed a refundable balance,
  // and ReturnService accepts a partially-refunded payment — so that phantom
  // balance funded a second real payout.
  it('an out-of-band refund of the balance settles the payment', () => {
    const r = resolveRefundSettlement({
      paymentAmount: PAYMENT,
      alreadyRefunded: 2000, // an in-band return already accounted
      reported: [3000], // merchant refunded the rest in the dashboard
      reportedEventId: 'rf-portal',
      accountedEventIds: ['rf-inband'],
    });
    expect(r.settledTotal, 'max() would have written 3000').toBe(PAYMENT);
    expect(r.isFullRefund, 'the gateway has returned everything').toBe(true);
  });

  it('two equal out-of-band refunds do not collapse', () => {
    const first = resolveRefundSettlement({
      paymentAmount: PAYMENT,
      alreadyRefunded: 0,
      reported: [2000],
      reportedEventId: 'rf-1',
      accountedEventIds: [],
    });
    expect(first.settledTotal).toBe(2000);

    const second = resolveRefundSettlement({
      paymentAmount: PAYMENT,
      alreadyRefunded: first.settledTotal,
      reported: [2000],
      reportedEventId: 'rf-2',
      accountedEventIds: ['rf-1'],
    });
    expect(second.settledTotal, 'max() would have held at 2000').toBe(4000);
    expect(second.isFullRefund).toBe(false);
  });

  it('the async settle notice for an in-band refund adds nothing', () => {
    const r = resolveRefundSettlement({
      paymentAmount: PAYMENT,
      alreadyRefunded: 2000,
      reported: [2000],
      reportedEventId: 'rf-inband',
      accountedEventIds: ['rf-inband'],
    });
    expect(r.settledTotal, 'the claim already counted this one').toBe(2000);
    expect(r.isFullRefund).toBe(false);
  });

  it('a redelivered webhook for a refund already counted adds nothing', () => {
    const r = resolveRefundSettlement({
      paymentAmount: PAYMENT,
      alreadyRefunded: 4000,
      reported: [2000],
      reportedEventId: 'rf-2',
      accountedEventIds: ['rf-1', 'rf-2'],
    });
    expect(r.settledTotal).toBe(4000);
  });

  it('holds the total when the provider names no refund id', () => {
    // Indistinguishable from a redelivery, so it may not raise the total.
    // Understating a refund is recoverable; paying one twice is not.
    const r = resolveRefundSettlement({
      paymentAmount: PAYMENT,
      alreadyRefunded: 2000,
      reported: [3000],
      reportedEventId: null,
      accountedEventIds: ['rf-inband'],
    });
    expect(r.settledTotal, 'no id — hold, never raise').toBe(3000);
    expect(r.isFullRefund).toBe(false);
  });

  it('accumulating past the payment settles it', () => {
    const r = resolveRefundSettlement({
      paymentAmount: PAYMENT,
      alreadyRefunded: 4000,
      reported: [2000],
      reportedEventId: 'rf-3',
      accountedEventIds: ['rf-1', 'rf-2'],
    });
    expect(r.isFullRefund).toBe(true);
    expect(r.settledTotal).toBe(6000);
  });
});

describe('the accounted-refund-id list', () => {
  it('reads an absent, malformed or non-array metadata as empty', () => {
    expect(readAccountedRefundEventIds(null)).toEqual([]);
    expect(readAccountedRefundEventIds('nope')).toEqual([]);
    expect(readAccountedRefundEventIds({ refundEventIds: 'a' })).toEqual([]);
    expect(readAccountedRefundEventIds({})).toEqual([]);
  });

  it('keeps only usable string ids', () => {
    expect(readAccountedRefundEventIds({ refundEventIds: ['a', '', null, 3, 'b'] })).toEqual([
      'a',
      'b',
    ]);
  });

  it('appends, and is idempotent for one already present', () => {
    expect(appendRefundEventId({ refundEventIds: ['a'] }, 'b')).toEqual(['a', 'b']);
    expect(appendRefundEventId({ refundEventIds: ['a'] }, 'a')).toEqual(['a']);
  });

  it('ignores an absent id rather than storing a blank', () => {
    expect(appendRefundEventId({ refundEventIds: ['a'] }, null)).toEqual(['a']);
    expect(appendRefundEventId({ refundEventIds: ['a'] }, '')).toEqual(['a']);
  });
});

describe('payments that predate the refund-id bookkeeping', () => {
  // Rows refunded before this shipped carry a refundedAmount but no ids. Their
  // pending settle webhook is indistinguishable from a brand-new refund, so it
  // must not be added — the legacy row is exactly where a double-count would
  // land silently.
  it('holds the total when a refund is accounted but no ids are recorded', () => {
    const r = resolveRefundSettlement({
      paymentAmount: PAYMENT,
      alreadyRefunded: 3000,
      reported: [2000],
      reportedEventId: 'rf-legacy',
      accountedEventIds: [],
    });
    expect(r.settledTotal, 'unknown provenance — hold').toBe(3000);
    expect(r.isFullRefund).toBe(false);
  });

  it('still accumulates once the list is being maintained', () => {
    const r = resolveRefundSettlement({
      paymentAmount: PAYMENT,
      alreadyRefunded: 3000,
      reported: [2000],
      reportedEventId: 'rf-new',
      accountedEventIds: ['rf-old'],
    });
    expect(r.settledTotal).toBe(PAYMENT);
  });

  it('a first refund on a clean payment needs no prior ids', () => {
    const r = resolveRefundSettlement({
      paymentAmount: PAYMENT,
      alreadyRefunded: 0,
      reported: [2000],
      reportedEventId: 'rf-1',
      accountedEventIds: [],
    });
    expect(r.settledTotal).toBe(2000);
  });
});

describe('the webhook duplicate check keys on refund identity', () => {
  // `metadata.refundStatus` is ONE scalar for the whole payment. Once any
  // refund settled it read 'completed' forever, so the NEXT refund's webhook
  // matched and returned before the settlement rule ran — making the cumulative
  // total dead code for out-of-band refunds, the only case it exists for.
  const tracked = { refundStatusById: { 'rf-1': 'completed' } };

  it('drops a redelivery of the same refund at the same status', () => {
    expect(
      isRefundEventAlreadySeen({
        metadata: tracked,
        refundId: 'rf-1',
        status: 'completed',
        previousPaymentStatus: 'completed',
      })
    ).toBe(true);
  });

  it('processes a DIFFERENT refund even after one has settled', () => {
    expect(
      isRefundEventAlreadySeen({
        metadata: tracked,
        refundId: 'rf-2',
        status: 'completed',
        previousPaymentStatus: 'completed',
      }),
      'this is the second portal refund the old gate swallowed'
    ).toBe(false);
  });

  it('processes the same refund moving to a new status', () => {
    expect(
      isRefundEventAlreadySeen({
        metadata: tracked,
        refundId: 'rf-1',
        status: 'canceled',
        previousPaymentStatus: 'completed',
      })
    ).toBe(false);
  });

  it('falls back to the payment-wide status when no id is given', () => {
    expect(
      isRefundEventAlreadySeen({
        metadata: tracked,
        refundId: null,
        status: 'completed',
        previousPaymentStatus: 'completed',
      })
    ).toBe(true);
  });

  it('falls back for a payment that predates the per-refund map', () => {
    // No regression for rows already in flight; those also refuse to raise the
    // refunded total, so nothing is added and nothing is reprocessed.
    expect(
      isRefundEventAlreadySeen({
        metadata: { refundStatus: 'completed' },
        refundId: 'rf-9',
        status: 'completed',
        previousPaymentStatus: 'completed',
      })
    ).toBe(true);
  });

  it('records per refund without disturbing the others', () => {
    expect(recordRefundStatus(tracked, 'rf-2', 'completed')).toEqual({
      'rf-1': 'completed',
      'rf-2': 'completed',
    });
    expect(recordRefundStatus(tracked, null, 'completed')).toEqual({ 'rf-1': 'completed' });
  });

  it('reads a malformed map as empty', () => {
    expect(readRefundStatusById({ refundStatusById: ['a'] })).toEqual({});
    expect(readRefundStatusById({ refundStatusById: { a: 3 } })).toEqual({});
    expect(readRefundStatusById(null)).toEqual({});
  });
});

describe('an id is only recorded when its amount was counted', () => {
  // Filing an id whose amount was HELD is worse than filing nothing: the real
  // refund carrying that id then looks already counted, so it is never added.
  it('reports the event as accounted when it raised the total', () => {
    const r = resolveRefundSettlement({
      paymentAmount: PAYMENT,
      alreadyRefunded: 2000,
      reported: [1000],
      reportedEventId: 'rf-new',
      accountedEventIds: ['rf-old'],
    });
    expect(r.settledTotal).toBe(3000);
    expect(r.accountedThisEvent).toBe(true);
  });

  it('reports NOT accounted when the total was merely held', () => {
    const r = resolveRefundSettlement({
      paymentAmount: PAYMENT,
      alreadyRefunded: 3000,
      reported: [2000],
      reportedEventId: 'rf-legacy',
      accountedEventIds: [], // unknown provenance — held
    });
    expect(r.settledTotal).toBe(3000);
    expect(r.accountedThisEvent, 'nothing of this event went in').toBe(false);
  });

  it('reports NOT accounted for an event already counted', () => {
    const r = resolveRefundSettlement({
      paymentAmount: PAYMENT,
      alreadyRefunded: 2000,
      reported: [2000],
      reportedEventId: 'rf-1',
      accountedEventIds: ['rf-1'],
    });
    expect(r.accountedThisEvent).toBe(false);
  });

  it('reports NOT accounted when the provider named no id', () => {
    const r = resolveRefundSettlement({
      paymentAmount: PAYMENT,
      alreadyRefunded: 2000,
      reported: [3000],
      reportedEventId: null,
      accountedEventIds: ['rf-1'],
    });
    expect(r.accountedThisEvent).toBe(false);
  });

  it('a first refund on a clean payment is accounted and recordable', () => {
    const r = resolveRefundSettlement({
      paymentAmount: PAYMENT,
      alreadyRefunded: 0,
      reported: [2000],
      reportedEventId: 'rf-1',
      accountedEventIds: [],
    });
    expect(r.settledTotal).toBe(2000);
    expect(r.accountedThisEvent, 'the refresh route must record this one').toBe(true);
  });
});
