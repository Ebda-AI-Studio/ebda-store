/**
 * The variant-aware stock helper every reader must go through.
 *
 * Regression context: `products.inventory` is not stock for a product that
 * has variants, but six call sites read it as if it were. Checkout also
 * decremented it on every variant sale, so it had drifted to -16 on live
 * products whose variants held four-figure stock.
 */
import { describe, it, expect } from 'vitest';
import { effectiveInventory, isOrderable } from '@api/lib/effective-inventory';

describe('effectiveInventory', () => {
  it('returns the product column when the product has no variants', () => {
    expect(effectiveInventory({ inventory: 7, variants: [] })).toBe(7);
    expect(effectiveInventory({ inventory: 7 })).toBe(7);
    expect(effectiveInventory({ inventory: 7, variants: null })).toBe(7);
  });

  it('sums the variants and ignores the parent column when variants exist', () => {
    expect(
      effectiveInventory({ inventory: -16, variants: [{ inventory: 1000 }, { inventory: 173 }] })
    ).toBe(1173);
  });

  it('never lets a corrupted negative parent leak through a variant product', () => {
    // The exact production shape: parent drifted negative, variants hold real stock.
    expect(effectiveInventory({ inventory: -16, variants: [{ inventory: 1173 }] })).toBe(1173);
  });

  it('returns 0, not the parent, for a variant product whose variants are empty', () => {
    expect(effectiveInventory({ inventory: -4, variants: [{ inventory: 0 }] })).toBe(0);
  });
});

describe('isOrderable', () => {
  const enabled = true;

  it('is always orderable when the product does not track inventory', () => {
    expect(isOrderable({ inventory: -16, trackInventory: false }, 5, enabled)).toBe(true);
  });

  it('uses variant stock for a variant product', () => {
    const p = { inventory: -16, trackInventory: true, variants: [{ inventory: 1173 }] };
    expect(isOrderable(p, 3, enabled)).toBe(true);
  });

  it('rejects when the requested qty exceeds variant stock and no backorder is allowed', () => {
    const p = {
      inventory: 0,
      trackInventory: true,
      allowBackorder: false,
      variants: [{ inventory: 2 }],
    };
    expect(isOrderable(p, 3, enabled)).toBe(false);
  });

  it('allows a backorder only when the feature flag AND the product flag are set', () => {
    const p = {
      inventory: 0,
      trackInventory: true,
      allowBackorder: true,
      variants: [{ inventory: 0 }],
    };
    expect(isOrderable(p, 3, true)).toBe(true);
    expect(isOrderable(p, 3, false)).toBe(false);
  });

  it('allows a backorder when any variant permits it, matching enrichStockFlags', () => {
    const p = {
      inventory: 0,
      trackInventory: true,
      allowBackorder: false,
      variants: [{ inventory: 0, allowBackorder: true }],
    };
    expect(isOrderable(p, 3, true)).toBe(true);
  });
});
