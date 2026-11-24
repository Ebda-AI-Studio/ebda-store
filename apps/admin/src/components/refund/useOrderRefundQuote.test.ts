import { describe, expect, it } from 'vitest';
import { selectionItems, emptySelection, type RefundQuote } from './useOrderRefundQuote';

const quote = (returnsEnabled?: boolean) =>
  ({
    lines: [
      { orderItemId: 'a', remaining: 2, trackInventory: true },
      { orderItemId: 'b', remaining: 1, trackInventory: false },
    ],
    ...(returnsEnabled === undefined ? {} : { returnsEnabled }),
  }) as unknown as RefundQuote;

const ticked = (q: RefundQuote) => {
  const s = emptySelection(q);
  for (const k of Object.keys(s)) s[k].checked = true;
  return s;
};

describe('selectionItems and the plan gate (REFUND-GATE-1)', () => {
  it('a plan without returns never asks for a restock: tracked lines send restock false', () => {
    const q = quote(false);
    expect(selectionItems(q, ticked(q))).toEqual([
      { orderItemId: 'a', quantity: 2, restock: false },
      { orderItemId: 'b', quantity: 1, restock: undefined },
    ]);
  });
  it('a plan with returns (or an older API without the flag) keeps the per-line choice', () => {
    for (const flag of [true, undefined]) {
      const q = quote(flag);
      expect(selectionItems(q, ticked(q))[0].restock).toBe(true);
    }
  });
});
