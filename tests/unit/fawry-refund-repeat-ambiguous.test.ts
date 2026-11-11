/**
 * Ruling FAWRY-REFUND-DEDUPE-1: EVERY repeated Fawry refund notice raises a P1 (with or without a reference number), since
 * nothing proves the reference changes per refund and the refund amount is unsigned. A payment notice and other providers
 * do not.
 */
import { describe, expect, it } from 'vitest';
import { isFawryRefundNotice } from '@api/services/payment-providers/webhook-signature';

const n = (over: Record<string, unknown> = {}) => ({
  fawryRefNumber: '999',
  merchantRefNumber: 'ORD-1',
  orderStatus: 'PARTIALLY_REFUNDED',
  paymentAmount: '1000.00',
  ...over,
});

describe('isFawryRefundNotice', () => {
  it('any Fawry refund or partial refund notice, with or without a reference number', () => {
    expect(isFawryRefundNotice('fawry', n())).toBe(true);
    expect(isFawryRefundNotice('fawry', n({ orderStatus: 'refunded' }))).toBe(true);
    expect(isFawryRefundNotice('fawry', n({ paymentRefrenceNumber: 'RF-1' }))).toBe(true);
  });
  it('a payment notice, or another provider, is not one', () => {
    expect(isFawryRefundNotice('fawry', n({ orderStatus: 'PAID' }))).toBe(false);
    expect(isFawryRefundNotice('paymob', n())).toBe(false);
    expect(isFawryRefundNotice('kashier', n())).toBe(false);
  });
});
