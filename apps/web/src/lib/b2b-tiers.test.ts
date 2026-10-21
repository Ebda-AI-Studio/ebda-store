import { describe, it, expect } from 'vitest';
import { tierRows, resolveQuantities, buyerPricesByQty, type PublicTier } from './b2b-tiers';

const t = (minQty: number, priceMinor: number, variantId: string | null = null): PublicTier => ({
  variantId,
  minQty,
  priceMinor,
});

describe('tierRows', () => {
  it('uses product-level breaks sorted ascending', () => {
    expect(tierRows([t(50, 7000), t(10, 9000)], null).map(r => r.minQty)).toEqual([10, 50]);
  });
  it("prefers the selected variant's own breaks when it has any, else falls back to the product-level ones", () => {
    const tiers = [t(10, 9000), t(5, 11000, 'xl')];
    expect(tierRows(tiers, 'xl').map(r => [r.minQty, r.priceMinor])).toEqual([[5, 11000]]);
    expect(tierRows(tiers, 's').map(r => r.minQty)).toEqual([10]);
  });
  it('keeps the lowest price for a duplicate quantity and is empty with no tiers', () => {
    expect(tierRows([t(10, 9000), t(10, 8500)], null)).toEqual([t(10, 8500)]);
    expect(tierRows([], null)).toEqual([]);
  });
});

describe('resolveQuantities / buyerPricesByQty', () => {
  it('asks for qty 1 and every break, deduplicated and capped under the endpoint limit', () => {
    expect(resolveQuantities([t(10, 1), t(50, 1)])).toEqual([1, 10, 50]);
    expect(resolveQuantities(Array.from({ length: 30 }, (_, i) => t(2 + i, 1))).length).toBe(11);
  });
  it('shows a buyer price only where it beats retail', () => {
    const p = (qty: number, unitPrice: number, listPrice = 10000) => ({
      productId: 'p',
      variantId: null,
      qty,
      unitPrice,
      listPrice,
      priceSource: 'group' as const,
    });
    expect([...buyerPricesByQty([p(1, 9000), p(10, 10000), p(50, 7000)])]).toEqual([
      [1, 9000],
      [50, 7000],
    ]);
  });
});
