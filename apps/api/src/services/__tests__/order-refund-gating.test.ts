import { describe, it, expect } from 'vitest';
import { hasCapturedPayment, shouldApplyRefundEffects } from '../order-refund-gating';

describe('hasCapturedPayment', () => {
  it('true when durable paymentStatus is paid', () => {
    expect(hasCapturedPayment({ paymentStatus: 'paid' })).toBe(true);
  });

  it('true when a payment row reached completed even if paymentStatus lags', () => {
    expect(
      hasCapturedPayment({ paymentStatus: 'unpaid', payments: [{ status: 'completed' }] })
    ).toBe(true);
  });

  it('false for an unpaid order with no completed payment', () => {
    expect(hasCapturedPayment({ paymentStatus: 'unpaid', payments: [{ status: 'pending' }] })).toBe(
      false
    );
  });

  it('false for an unpaid order with no payment rows', () => {
    expect(hasCapturedPayment({ paymentStatus: 'unpaid' })).toBe(false);
    expect(hasCapturedPayment({ paymentStatus: 'unpaid', payments: [] })).toBe(false);
    expect(hasCapturedPayment({})).toBe(false);
  });

  it('false when payment is failed (not completed)', () => {
    expect(hasCapturedPayment({ paymentStatus: 'failed', payments: [{ status: 'failed' }] })).toBe(
      false
    );
  });
});

describe('shouldApplyRefundEffects — the cancel/refund side-effects gate', () => {
  it('cancelling an UNPAID order does NOT apply refund effects (no "Refund issued" push)', () => {
    // The core bug: an online order whose payment link was never completed.
    const unpaidOrder = { paymentStatus: 'unpaid', payments: [{ status: 'pending' }] };
    expect(shouldApplyRefundEffects('cancelled', unpaidOrder)).toBe(false);
  });

  it('cancelling a PAID order DOES apply refund effects (refund + "Refund issued")', () => {
    const paidOrder = { paymentStatus: 'paid', payments: [{ status: 'completed' }] };
    expect(shouldApplyRefundEffects('cancelled', paidOrder)).toBe(true);
  });

  it('refunding a PAID order applies refund effects', () => {
    expect(shouldApplyRefundEffects('refunded', { paymentStatus: 'paid' })).toBe(true);
  });

  it('refunding an order with no captured payment does not apply refund effects (defensive)', () => {
    expect(shouldApplyRefundEffects('refunded', { paymentStatus: 'unpaid' })).toBe(false);
  });

  it('non-terminal statuses never apply refund effects regardless of payment', () => {
    const paidOrder = { paymentStatus: 'paid' };
    for (const status of ['pending', 'confirmed', 'processing', 'shipped', 'delivered']) {
      expect(shouldApplyRefundEffects(status, paidOrder)).toBe(false);
    }
  });
});
