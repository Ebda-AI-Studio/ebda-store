import { describe, it, expect } from 'vitest';
import { assertOrderFulfillable, isFulfillable } from '@api/lib/order-fulfilment-guard';

describe('order fulfilment guard (SP6a)', () => {
  it('an order awaiting InstaPay confirmation is not fulfillable', () => {
    expect(isFulfillable({ status: 'awaiting_payment_confirmation' })).toBe(false);
    expect(() => assertOrderFulfillable({ status: 'awaiting_payment_confirmation' })).toThrow(
      expect.objectContaining({ code: 'ORDER_AWAITING_PAYMENT_CONFIRMATION', statusCode: 409 })
    );
  });

  it('every other status is left to the state machine', () => {
    for (const status of [
      'pending',
      'confirmed',
      'processing',
      'shipped',
      'delivered',
      'cancelled',
    ]) {
      expect(isFulfillable({ status })).toBe(true);
    }
  });
});
