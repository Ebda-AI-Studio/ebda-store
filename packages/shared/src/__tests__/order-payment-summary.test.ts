import { describe, it, expect } from 'vitest';
import { orderPaymentSummary, orderPaymentState } from '../order-payment-summary';
import { orderActionVisibility } from '../order-action-visibility';

const base = { status: 'delivered', total: 16000 };

describe('orderPaymentSummary', () => {
  // Live QA (Amelia ORD-TOZJNY-7Y485): a refund through a RETURN keeps paymentStatus = paid and the status delivered, so the header
  // said "Paid" over "Refunded EGP 7,300". The recorded money decides.
  it('a full refund through a return reads Refunded, not Paid', () => {
    expect(
      orderPaymentSummary({
        status: 'delivered',
        paymentStatus: 'paid',
        total: 730000,
        refundedTotal: 730000,
      })
    ).toEqual({ state: 'refunded', refunded: 730000, remain: 0 });
    expect(
      orderPaymentSummary({
        status: 'delivered',
        paymentStatus: 'paid',
        total: 730000,
        payments: [{ refundedAmount: 730000 }],
      }).state
    ).toBe('refunded');
  });
  it('a partial refund reads Partially refunded and keeps the refunded amount', () => {
    expect(
      orderPaymentSummary({
        status: 'delivered',
        paymentStatus: 'paid',
        total: 730000,
        refundedTotal: 200000,
      })
    ).toEqual({ state: 'partially_refunded', refunded: 200000, remain: 0 });
  });
  it('nothing refunded stays Paid; a zero-total order is never "refunded"', () => {
    expect(
      orderPaymentSummary({ status: 'delivered', paymentStatus: 'paid', total: 730000 }).state
    ).toBe('paid');
    expect(
      orderPaymentSummary({
        status: 'delivered',
        paymentStatus: 'paid',
        total: 0,
        refundedTotal: 0,
      }).state
    ).toBe('paid');
  });
  it('the status-column state never says partially_refunded (mark-paid visibility stays on it)', () => {
    expect(orderPaymentState({ status: 'delivered', paymentStatus: 'paid' })).toBe('paid');
  });

  it('fully refunded COD (paymentStatus refunded): Refunded, nothing owed', () => {
    expect(
      orderPaymentSummary({
        ...base,
        status: 'refunded',
        paymentStatus: 'refunded',
        payments: [{ refundedAmount: 16000 }],
      })
    ).toEqual({ state: 'refunded', refunded: 16000, remain: 0 });
  });
  it('refunded paymentStatus with no payment rows stamped reports the total (it was paid)', () => {
    expect(orderPaymentSummary({ ...base, paymentStatus: 'refunded', payments: [] })).toEqual({
      state: 'refunded',
      refunded: 16000,
      remain: 0,
    });
  });
  it('status-only refund of a never-paid COD order: Refunded, nothing owed, nothing refunded', () => {
    expect(orderPaymentSummary({ ...base, status: 'refunded', paymentStatus: 'unpaid' })).toEqual({
      state: 'refunded',
      refunded: 0,
      remain: 0,
    });
  });
  it('status-only refund of a paid order: Refunded (not Paid), total back when no amount is recorded', () => {
    expect(orderPaymentSummary({ ...base, status: 'refunded', paymentStatus: 'paid' })).toEqual({
      state: 'refunded',
      refunded: 16000,
      remain: 0,
    });
    expect(
      orderPaymentSummary({
        ...base,
        status: 'refunded',
        paymentStatus: 'paid',
        refundedTotal: 9000,
      }).refunded
    ).toBe(9000);
  });
  it('disputed owes nothing', () => {
    expect(orderPaymentSummary({ ...base, paymentStatus: 'disputed' })).toEqual({
      state: 'disputed',
      refunded: 0,
      remain: 0,
    });
  });
  it('a cancelled unpaid order owes nothing', () => {
    expect(orderPaymentSummary({ ...base, status: 'cancelled', paymentStatus: 'unpaid' })).toEqual({
      state: 'unpaid',
      refunded: 0,
      remain: 0,
    });
  });
  it('paid stays paid until money is handed back; a partial refund (API refundedTotal, which includes merchant-booked ones) reads Partially refunded without owing', () => {
    expect(orderPaymentSummary({ ...base, paymentStatus: 'paid' })).toEqual({
      state: 'paid',
      refunded: 0,
      remain: 0,
    });
    expect(
      orderPaymentSummary({ ...base, paymentStatus: 'paid', payments: [{ refundedAmount: 5000 }] })
        .refunded
    ).toBe(5000);
    expect(
      orderPaymentSummary({
        ...base,
        paymentStatus: 'paid',
        payments: [{ refundedAmount: 0 }],
        refundedTotal: 3000,
      })
    ).toEqual({ state: 'partially_refunded', refunded: 3000, remain: 0 });
  });
  it('unpaid owes the total less the wallet part', () => {
    expect(
      orderPaymentSummary({
        ...base,
        status: 'pending',
        paymentStatus: 'unpaid',
        walletAmount: 1000,
      })
    ).toEqual({
      state: 'unpaid',
      refunded: 0,
      remain: 15000,
    });
  });
});

describe('card and buttons agree (orderActionVisibility.showMarkPaid === state is unpaid)', () => {
  const cases = [
    { status: 'refunded', paymentStatus: 'refunded' },
    { status: 'refunded', paymentStatus: 'unpaid' },
    { status: 'refunded', paymentStatus: 'paid' },
    { status: 'delivered', paymentStatus: 'disputed' },
    { status: 'delivered', paymentStatus: 'paid' },
    { status: 'pending', paymentStatus: 'unpaid' },
  ];
  for (const c of cases)
    it(`${c.status}/${c.paymentStatus}`, () => {
      expect(orderActionVisibility({ ...c, payments: [] }).showMarkPaid).toBe(
        orderPaymentState(c) === 'unpaid'
      );
    });
});
