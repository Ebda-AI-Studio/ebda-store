import { describe, it, expect } from 'vitest';
import { refundedTotal } from './order-refunded-total';

describe('refundedTotal', () => {
  it('counts a merchant-booked partial refund that is not mirrored on the payment row', () => {
    expect(
      refundedTotal(
        [{ refundedAmount: 0, metadata: {} }],
        [{ metadata: { refundKey: 'k1', amount: 4000 } }]
      )
    ).toBe(4000);
  });
  it('does not count a provider refund twice (external flag, or refundKey listed on the payment)', () => {
    expect(
      refundedTotal(
        [{ refundedAmount: 7000, metadata: { refundEventIds: ['re_1'] } }],
        [
          { metadata: { refundKey: 're_1', amount: 7000 } },
          { metadata: { refundKey: 're_2', amount: 7000, external: true } },
        ]
      )
    ).toBe(7000);
  });
  it('adds payments and booked amounts, ignores garbage', () => {
    expect(
      refundedTotal(
        [{ refundedAmount: 1000 }, { refundedAmount: null }],
        [
          { metadata: { refundKey: 'a', amount: 2000 } },
          { metadata: null },
          { metadata: { amount: 'x' } },
        ]
      )
    ).toBe(3000);
  });

  it('counts a completed return paid out by cash (not on the payment row): return 100 + cash 3,260 -> Refunded 3,360', () => {
    expect(
      refundedTotal(
        [{ refundedAmount: 0, metadata: {} }],
        // both returns flagged `external` on their order events: they were never counted by the event rule
        [
          { metadata: { refundKey: 'r1', amount: 100, external: true } },
          { metadata: { refundKey: 'r2', amount: 3260, external: true } },
        ],
        [
          { refundMethod: 'cash', refundAmount: 100 },
          { refundMethod: 'cash', refundAmount: 3260 },
        ]
      )
    ).toBe(3360);
  });
  it('does not count a gateway return twice (its amount is already on the payment row)', () => {
    expect(
      refundedTotal(
        [{ refundedAmount: 5000, metadata: {} }],
        [],
        [{ refundMethod: 'original_payment', refundAmount: 5000 }]
      )
    ).toBe(5000);
  });

  it('a completed EXCHANGE adds 0: it moves no money, its refund_amount is only the create-time estimate', () => {
    expect(
      refundedTotal(
        [{ refundedAmount: 0, metadata: {} }],
        [],
        [
          { type: 'exchange', refundMethod: 'cash', refundAmount: 5000 },
          { type: 'return', refundMethod: 'cash', refundAmount: 100 },
        ]
      )
    ).toBe(100);
  });
});
