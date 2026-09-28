/**
 * Partial-return allocation — the single figure the GL credits to cash AND
 * the amount refunded at the payment provider.
 *
 * These two used to be computed in different places from different premises.
 * `ReturnService.complete` passed `returnRequest.refundAmount ?? undefined` to
 * `PaymentService.refund`; that column is `Int @default(0)` and NOT NULL, so a
 * partial return whose amount was never entered passed `0`, and the old
 * `isFullRefund = !request.amount || …` predicate read `0` as "refund
 * everything". The customer got the WHOLE order back at the provider and
 * `postRefundJournal` reversed the entire sale — erasing the revenue, tax and
 * COGS for the items they kept. Exactly the outcome partial-return-posting.ts
 * exists to prevent, reached by the one producer that never fired its event.
 *
 * The allocator is now shared, so these tests pin the arithmetic once for both
 * consumers.
 */

import { describe, it, expect } from 'vitest';
import { allocatePartialReturn } from '@api/services/accounting/posting/partial-return-allocation';

/** Two lines: 2 × 10.000 KWD and 1 × 5.000 KWD. Subtotal 25.000. */
const LINES = [
  { id: 'oi-1', quantity: 2, price: 10_000 },
  { id: 'oi-2', quantity: 1, price: 5_000 },
];
const SUBTOTAL = 25_000;

function alloc(
  requested: Array<{ orderItemId: string; quantity: number }>,
  prev: Array<[string, number]> = [],
  money: { discount: number; tax: number; taxIncludedInPrice?: boolean } = { discount: 0, tax: 0 }
) {
  return allocatePartialReturn({
    subtotal: SUBTOTAL,
    discount: money.discount,
    tax: money.tax,
    taxIncludedInPrice: money.taxIncludedInPrice,
    lines: LINES,
    prevQty: new Map(prev),
    requested,
  });
}

describe('allocatePartialReturn', () => {
  it('values one returned unit at its own line price, not a share of the order', () => {
    const r = alloc([{ orderItemId: 'oi-1', quantity: 1 }]);
    expect(r.curGross).toBe(10_000);
    expect(r.cashCredit).toBe(10_000);
    expect(r.returnedLines).toHaveLength(1);
  });

  it('allocates order-level discount and tax pro-rata by gross', () => {
    // 5.000 discount and 1.250 tax across a 25.000 subtotal; returning 10.000
    // of gross is 40% of the order.
    const r = alloc([{ orderItemId: 'oi-1', quantity: 1 }], [], { discount: 5_000, tax: 1_250 });
    expect(r.discountThis).toBe(2_000); // 40% of 5.000
    expect(r.taxThis).toBe(500); // 40% of 1.250
    expect(r.revenueDebit).toBe(8_000); // 10.000 − 2.000
    expect(r.cashCredit).toBe(8_500); // 8.000 + 500
  });

  it('never lets a sequence of partial returns exceed the order-level totals', () => {
    // The property that makes cumulative-floor allocation worth the complexity:
    // three separate returns covering the whole order must sum to EXACTLY the
    // order's discount and tax, with no per-return rounding drift.
    const money = { discount: 5_000, tax: 1_250 };
    const first = alloc([{ orderItemId: 'oi-1', quantity: 1 }], [], money);
    const second = alloc([{ orderItemId: 'oi-1', quantity: 1 }], [['oi-1', 1]], money);
    const third = alloc(
      [{ orderItemId: 'oi-2', quantity: 1 }],
      [
        ['oi-1', 2],
        ['oi-2', 0],
      ],
      money
    );

    expect(first.discountThis + second.discountThis + third.discountThis).toBe(money.discount);
    expect(first.taxThis + second.taxThis + third.taxThis).toBe(money.tax);
    expect(first.cashCredit + second.cashCredit + third.cashCredit).toBe(
      SUBTOTAL - money.discount + money.tax
    );
  });

  it('clamps a claim to the line remainder after prior returns', () => {
    const r = alloc([{ orderItemId: 'oi-1', quantity: 5 }], [['oi-1', 1]]);
    expect(r.returnedLines[0].qty).toBe(1); // 2 ordered − 1 already returned
    expect(r.curGross).toBe(10_000);
  });

  it('returns nothing when every claimed line is already fully returned', () => {
    const r = alloc(
      [{ orderItemId: 'oi-1', quantity: 2 }],
      [
        ['oi-1', 2],
        ['oi-2', 0],
      ]
    );
    expect(r.returnedLines).toHaveLength(0);
    expect(r.cashCredit).toBe(0);
  });

  it('ignores a line that does not belong to the order', () => {
    const r = alloc([{ orderItemId: 'not-this-order', quantity: 1 }]);
    expect(r.returnedLines).toHaveLength(0);
    expect(r.curGross).toBe(0);
  });

  it('does not double-count a duplicated orderItemId in one payload', () => {
    const r = alloc([
      { orderItemId: 'oi-1', quantity: 1 },
      { orderItemId: 'oi-1', quantity: 1 },
      { orderItemId: 'oi-1', quantity: 1 },
    ]);
    // The line only has 2 units; the third claim must find no remainder.
    expect(r.returnedLines.reduce((n, l) => n + l.qty, 0)).toBe(2);
    expect(r.curGross).toBe(20_000);
  });

  it('a FULL return values at the whole order — which is why it must not use this path', () => {
    // Not a recommendation: this documents the boundary. When every line is
    // returned, cashCredit equals the whole order, which WOULD satisfy
    // PaymentService's isFullRefund. ReturnService only takes the derived
    // amount for a partial return, and clamps it below payment.amount.
    const r = alloc(
      [
        { orderItemId: 'oi-1', quantity: 2 },
        { orderItemId: 'oi-2', quantity: 1 },
      ],
      [],
      { discount: 5_000, tax: 1_250 }
    );
    expect(r.cashCredit).toBe(SUBTOTAL - 5_000 + 1_250);
  });

  it('does NOT add the tax share back on a tax-INCLUSIVE order', () => {
    // Same order as the pro-rata case above, but the store's listed prices
    // already contained the VAT (ruling M3-7): `subtotal` is gross and the
    // customer never paid `tax` on top of it. Crediting revenueDebit + taxThis
    // would hand back 500 fils of VAT the customer was never charged
    // separately — the order's own `taxIncludedInPrice` is what distinguishes
    // the two, so an inclusive order refunds the line value and no more.
    const r = alloc([{ orderItemId: 'oi-1', quantity: 1 }], [], {
      discount: 5_000,
      tax: 1_250,
      taxIncludedInPrice: true,
    });
    expect(r.discountThis).toBe(2_000); // unchanged — discount is convention-agnostic
    expect(r.taxThis).toBe(500); // unchanged — still 40% of the VAT
    expect(r.cashCredit).toBe(8_000); // the gross line value less its discount share
    expect(r.revenueDebit).toBe(7_500); // 8.000 − 500 of VAT that was inside it
    // The GL adjustment must still balance: DR revenue + DR tax = CR cash.
    expect(r.revenueDebit + r.taxThis).toBe(r.cashCredit);
  });

  it('a full tax-INCLUSIVE return credits the order once, VAT included', () => {
    // The exclusive counterpart above sums to `subtotal − discount + tax`.
    // Inclusive, the tax is already inside `subtotal`, so the same sweep must
    // stop at `subtotal − discount` — anything more refunds the VAT twice.
    const money = { discount: 5_000, tax: 1_250, taxIncludedInPrice: true };
    const first = alloc([{ orderItemId: 'oi-1', quantity: 1 }], [], money);
    const second = alloc([{ orderItemId: 'oi-1', quantity: 1 }], [['oi-1', 1]], money);
    const third = alloc(
      [{ orderItemId: 'oi-2', quantity: 1 }],
      [
        ['oi-1', 2],
        ['oi-2', 0],
      ],
      money
    );

    expect(first.taxThis + second.taxThis + third.taxThis).toBe(money.tax);
    expect(first.cashCredit + second.cashCredit + third.cashCredit).toBe(SUBTOTAL - money.discount);
  });

  it('treats a zero subtotal as no allocation rather than dividing by it', () => {
    const r = allocatePartialReturn({
      subtotal: 0,
      discount: 1_000,
      tax: 500,
      lines: LINES,
      prevQty: new Map(),
      requested: [{ orderItemId: 'oi-1', quantity: 1 }],
    });
    expect(r.discountThis).toBe(0);
    expect(r.taxThis).toBe(0);
    expect(r.cashCredit).toBe(10_000);
  });
});
