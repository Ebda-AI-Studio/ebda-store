import { describe, it, expect } from 'vitest';
import { orderPaymentSummary } from '../order-payment-summary';

const base = { status: 'delivered', total: 16000 };

describe('orderPaymentSummary', () => {
  it('a fully refunded COD order is Refunded with nothing owed, not Unpaid / Remain', () => {
    const s = orderPaymentSummary({
      ...base,
      status: 'refunded',
      paymentStatus: 'refunded',
      payments: [{ refundedAmount: 16000 }],
    });
    expect(s).toEqual({ state: 'refunded', refunded: 16000, remain: 0 });
  });
  it('refunded by status only (payment rows not yet stamped) still reports the order total as refunded', () => {
    const s = orderPaymentSummary({ ...base, paymentStatus: 'refunded', payments: [] });
    expect(s).toEqual({ state: 'refunded', refunded: 16000, remain: 0 });
  });
  it('paid stays paid, and a partial refund shows what went back without owing anything', () => {
    expect(orderPaymentSummary({ ...base, paymentStatus: 'paid' })).toEqual({
      state: 'paid',
      refunded: 0,
      remain: 0,
    });
    expect(
      orderPaymentSummary({ ...base, paymentStatus: 'paid', payments: [{ refundedAmount: 5000 }] })
    ).toEqual({ state: 'paid', refunded: 5000, remain: 0 });
  });
  it('unpaid owes the total less the wallet part', () => {
    expect(
      orderPaymentSummary({
        ...base,
        status: 'pending',
        paymentStatus: 'unpaid',
        walletAmount: 1000,
      })
    ).toEqual({ state: 'unpaid', refunded: 0, remain: 15000 });
  });
});
