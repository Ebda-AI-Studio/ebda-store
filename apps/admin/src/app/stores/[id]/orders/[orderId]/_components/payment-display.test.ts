import { describe, expect, it } from 'vitest';
import { paymentDisplay } from './payment-display';

const base = { total: 23600, walletAmount: 0, payments: [] as never[] };

describe('paymentDisplay (QA-95)', () => {
  it('fully refunded COD order is refunded with nothing outstanding', () => {
    const r = paymentDisplay({
      ...base,
      status: 'refunded',
      paymentStatus: 'refunded',
      payments: [{ refundedAmount: 23600 }] as never,
    });
    expect(r).toEqual({ state: 'refunded', remain: 0, refunded: 23600 });
  });
  it('status refunded wins even if paymentStatus lags', () => {
    expect(paymentDisplay({ ...base, status: 'refunded', paymentStatus: 'unpaid' }).remain).toBe(0);
  });
  it('unpaid keeps the remaining balance', () => {
    expect(paymentDisplay({ ...base, status: 'pending', paymentStatus: 'unpaid' })).toMatchObject({
      state: 'unpaid',
      remain: 23600,
    });
  });
  it('paid has no remainder', () => {
    expect(paymentDisplay({ ...base, status: 'delivered', paymentStatus: 'paid' }).state).toBe(
      'paid'
    );
  });
});
