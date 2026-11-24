/**
 * #1908 — the money-action gating shared by the admin order page and the
 * orders PWA. One rule, tested once.
 */
import { describe, it, expect } from 'vitest';
import { orderActionVisibility, refundViaProviderRemaining } from '../order-action-visibility';

const card = (status: string, extra: Record<string, unknown> = {}) => ({
  provider: 'paymob',
  status,
  transactionId: 'txn_1',
  ...extra,
});

describe('orderActionVisibility', () => {
  it('a refunded COD order does not offer mark-paid again', () => {
    const v = orderActionVisibility({
      status: 'refunded',
      paymentStatus: 'refunded',
      payments: [{ provider: 'cod', status: 'refunded' }],
    });
    expect(v.showMarkPaid).toBe(false);
    expect(v.showManualMarkPaid).toBe(false);
  });

  it('unpaid COD order: manual mark-paid is offered', () => {
    const v = orderActionVisibility({
      status: 'pending',
      paymentStatus: 'unpaid',
      payments: [{ provider: 'cod', status: 'cod_pending' }],
    });
    expect(v.showMarkPaid).toBe(true);
    expect(v.hasProviderPayment).toBe(false);
    expect(v.showManualMarkPaid).toBe(true);
    expect(v.showRefundViaProvider).toBe(false);
  });

  it('unpaid order with a provider payment link: NO manual mark-paid', () => {
    const v = orderActionVisibility({
      status: 'pending',
      paymentStatus: 'unpaid',
      payments: [
        { provider: 'kashier', status: 'pending', transactionId: null, paymentUrl: 'https://pay' },
      ],
    });
    expect(v.showMarkPaid).toBe(true);
    expect(v.hasProviderPayment).toBe(true);
    expect(v.showManualMarkPaid).toBe(false);
  });

  it('paid card order: refund via provider, no refresh-refund', () => {
    const v = orderActionVisibility({
      status: 'confirmed',
      paymentStatus: 'paid',
      payments: [card('completed')],
    });
    expect(v.showRefundViaProvider).toBe(true);
    expect(v.showRefreshRefundStatus).toBe(false);
    expect(v.showManualMarkPaid).toBe(false);
  });

  it('partially refunded card payment: refund stays available (#1360) and refresh shows', () => {
    const v = orderActionVisibility({
      status: 'delivered',
      paymentStatus: 'paid',
      payments: [card('partially_refunded')],
    });
    expect(v.showRefundViaProvider).toBe(true);
    expect(v.showRefreshRefundStatus).toBe(true);
  });

  it('refunded order: no refund button, refresh-refund shows', () => {
    const v = orderActionVisibility({
      status: 'refunded',
      paymentStatus: 'refunded',
      payments: [card('refunded')],
    });
    expect(v.showRefundViaProvider).toBe(false);
    expect(v.showRefreshRefundStatus).toBe(true);
  });

  it('paid COD / manually paid order: never refund via provider', () => {
    const v = orderActionVisibility({
      status: 'delivered',
      paymentStatus: 'paid',
      payments: [{ provider: 'cod', status: 'completed', transactionId: null }],
    });
    expect(v.showRefundViaProvider).toBe(false);
  });

  it('no payments array at all', () => {
    const v = orderActionVisibility({ status: 'pending', paymentStatus: 'unpaid' });
    expect(v.showManualMarkPaid).toBe(true);
    expect(v.showRefundViaProvider).toBe(false);
  });
});

describe('refundViaProviderRemaining (#2069)', () => {
  const pay = (over: Record<string, unknown>) => ({
    provider: 'kashier',
    status: 'completed',
    transactionId: 'tx',
    amount: 5000,
    refundedAmount: 0,
    createdAt: '2026-09-01T00:00:00Z',
    ...over,
  });

  it('quotes what is left after a partial refund, not the order value', () => {
    expect(
      refundViaProviderRemaining({
        status: 'delivered',
        paymentStatus: 'paid',
        payments: [pay({ status: 'partially_refunded', refundedAmount: 2000 })],
      })
    ).toBe(3000);
  });

  it('reads the NEWEST refundable row — the one the route refunds', () => {
    expect(
      refundViaProviderRemaining({
        status: 'delivered',
        paymentStatus: 'paid',
        payments: [
          pay({ amount: 9000, createdAt: '2026-08-01T00:00:00Z' }),
          pay({ amount: 4000, refundedAmount: 500, createdAt: '2026-09-02T00:00:00Z' }),
          pay({ status: 'failed', amount: 1, createdAt: '2026-09-03T00:00:00Z' }),
        ],
      })
    ).toBe(3500);
  });

  it('is unknown (null), not 0, when the payload lacks the figures', () => {
    expect(
      refundViaProviderRemaining({
        status: 'delivered',
        paymentStatus: 'paid',
        payments: [{ provider: 'kashier', status: 'completed', transactionId: 'tx' }],
      })
    ).toBeNull();
    expect(refundViaProviderRemaining({ status: 'x', paymentStatus: 'paid' })).toBeNull();
  });
});

// SP6a — InstaPay is a manual provider: no payment link, no provider refresh, no
// manual mark-paid while it awaits the merchant's confirmation, and no refund
// "via provider" afterwards (the merchant refunds outside the system).
describe('orderActionVisibility - InstaPay', () => {
  const instapay = (status: string) => ({
    provider: 'instapay',
    status,
    transactionId: 'instapay_k1',
  });

  it('awaiting: only the dedicated confirm is offered', () => {
    const v = orderActionVisibility({
      status: 'awaiting_payment_confirmation',
      paymentStatus: 'unpaid',
      payments: [instapay('pending')],
    });
    expect(v.showConfirmInstapay).toBe(true);
    expect(v.showMarkPaid).toBe(false); // no payment link / provider refresh
    expect(v.showManualMarkPaid).toBe(false);
    expect(v.hasProviderPayment).toBe(false);
    expect(v.showRefundViaProvider).toBe(false);
  });

  it('once confirmed: no confirm button, and refund is NOT via a provider', () => {
    const v = orderActionVisibility({
      status: 'confirmed',
      paymentStatus: 'paid',
      payments: [instapay('completed')],
    });
    expect(v.showConfirmInstapay).toBe(false);
    expect(v.showRefundViaProvider).toBe(false);
    expect(v.showManualMarkPaid).toBe(false);
  });

  it('a cancelled/expired hold offers nothing', () => {
    const v = orderActionVisibility({
      status: 'cancelled',
      paymentStatus: 'unpaid',
      payments: [instapay('expired')],
    });
    expect(v.showConfirmInstapay).toBe(false);
  });
});
