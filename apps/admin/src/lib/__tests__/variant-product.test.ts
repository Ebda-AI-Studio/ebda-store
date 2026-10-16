import { describe, it, expect } from 'vitest';
import { isVariantProduct } from '../variant-product';

describe('isVariantProduct (W1a re-review minor 4)', () => {
  it('the variant row count wins over a drifted column', () => {
    expect(isVariantProduct({ variantCount: 2, hasVariants: false })).toBe(true);
    expect(isVariantProduct({ variantCount: 0, hasVariants: true })).toBe(false);
  });
  it('falls back to the column only when the count is absent', () => {
    expect(isVariantProduct({ hasVariants: true })).toBe(true);
    expect(isVariantProduct({})).toBe(false);
    expect(isVariantProduct(undefined)).toBe(false);
  });
});
