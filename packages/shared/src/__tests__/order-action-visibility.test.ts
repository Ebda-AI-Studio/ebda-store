/**
 * #1908 — the money-action gating shared by the admin order page and the
 * orders PWA. One rule, tested once.
 */
import { describe, it, expect } from 'vitest';
import { orderActionVisibility } from '../order-action-visibility';

const card = (status: string, extra: Record<string, unknown> = {}) => ({
  provider: 'myfatoorah',
  status,
  transactionId: 'txn_1',
  ...extra,
});

describe('orderActionVisibility', () => {
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
        { provider: 'tap', status: 'pending', transactionId: null, paymentUrl: 'https://pay' },
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
