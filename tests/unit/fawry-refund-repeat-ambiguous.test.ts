/**
 * Ruling FAWRY-REFUND-DEDUPE-1: a repeated Fawry refund notice with no payment reference number cannot be told apart from a
 * second partial refund of the same amount; the route raises a P1 on it instead of dropping it silently.
 */
import { describe, expect, it } from 'vitest';
import { isAmbiguousRefundRepeat } from '@api/services/payment-providers/webhook-signature';

const n = (over: Record<string, unknown> = {}) => ({
  fawryRefNumber: '999',
  merchantRefNumber: 'ORD-1',
  orderStatus: 'PARTIALLY_REFUNDED',
  paymentAmount: '1000.00',
  ...over,
});

describe('isAmbiguousRefundRepeat', () => {
  it('a Fawry refund / partial refund notice with no reference number is ambiguous', () => {
    expect(isAmbiguousRefundRepeat('fawry', n())).toBe(true);
    expect(isAmbiguousRefundRepeat('fawry', n({ orderStatus: 'refunded' }))).toBe(true);
    expect(isAmbiguousRefundRepeat('fawry', n({ paymentRefrenceNumber: '  ' }))).toBe(true);
  });
  it('a reference number, a payment notice, or another provider is a plain redelivery', () => {
    expect(isAmbiguousRefundRepeat('fawry', n({ paymentRefrenceNumber: 'RF-1' }))).toBe(false);
    expect(isAmbiguousRefundRepeat('fawry', n({ orderStatus: 'PAID' }))).toBe(false);
    expect(isAmbiguousRefundRepeat('paymob', n())).toBe(false);
    expect(isAmbiguousRefundRepeat('kashier', n())).toBe(false);
  });
});
