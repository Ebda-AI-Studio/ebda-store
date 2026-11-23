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
});
