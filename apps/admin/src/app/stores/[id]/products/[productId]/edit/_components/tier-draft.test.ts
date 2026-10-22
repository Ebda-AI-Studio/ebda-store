import { describe, it, expect } from 'vitest';
import { checkTierDraft } from './tier-draft';

const ctx = { existing: [], productPriceMinor: 10_000, costPriceMinor: 6_000 };
const draft = (minQty: string, price: string, extra = {}) => ({
  variantId: null,
  groupId: null,
  minQty,
  price,
  ...extra,
});

describe('checkTierDraft (client-side only; the server stays the authority)', () => {
  it('accepts a valid break and reports the margin on cost', () => {
    const r = checkTierDraft(draft('10', '80'), ctx);
    expect(r.problem).toBeNull();
    expect(r.tier).toEqual({ variantId: null, groupId: null, minQty: 10, priceMinor: 8_000 });
    expect(r.marginPercent).toBe(25); // (80 - 60) / 80
  });
  it('rejects a price at or above the current price, a quantity under 2, and an unparseable price', () => {
    expect(checkTierDraft(draft('10', '100'), ctx).problem).toBe('TIER_ABOVE_BASE');
    expect(checkTierDraft(draft('10', '120'), ctx).problem).toBe('TIER_ABOVE_BASE');
    expect(checkTierDraft(draft('1', '80'), ctx).problem).toBe('MIN_QTY');
    expect(checkTierDraft(draft('2.5', '80'), ctx).problem).toBe('MIN_QTY');
    expect(checkTierDraft(draft('10', 'abc'), ctx).problem).toBe('PRICE');
    expect(checkTierDraft(draft('10', ''), ctx).problem).toBe('PRICE');
    expect(checkTierDraft(draft('10', '80.555'), ctx).problem).toBe('PRICE');
  });
  it('warns, without blocking, below cost and below the minimum order', () => {
    const r = checkTierDraft(draft('5', '50'), { ...ctx, moq: 12 });
    expect(r.problem).toBeNull();
    expect(r.warnings.sort()).toEqual(['TIER_BELOW_COST', 'TIER_BELOW_MOQ']);
  });
  it('rejects a bigger quantity that is not cheaper than a smaller one', () => {
    const existing = [{ variantId: null, groupId: null, minQty: 10, priceMinor: 8_000 }];
    expect(checkTierDraft(draft('20', '85'), { ...ctx, existing }).problem).toBe(
      'TIER_NOT_MONOTONE'
    );
  });
});
