/**
 * #1919 — a variant whose price is null inherits the product price. The admin
 * manual-order picker priced it at 0, and the mass-edit grid showed 0.000 and
 * then SAVED 0 as an override for every inheriting variant it loaded.
 */
import { describe, it, expect } from 'vitest';
import { effectiveVariantPrice, variantPriceToField, variantFieldToPrice } from '../variant-price';

describe('variant price helpers', () => {
  it('a null override sells at the product price', () => {
    expect(effectiveVariantPrice(null, 4500)).toBe(4500);
  });

  it('a real override (including 0) wins', () => {
    expect(effectiveVariantPrice(3000, 4500)).toBe(3000);
    expect(effectiveVariantPrice(0, 4500)).toBe(0);
  });

  it('an inheriting variant renders as an empty field, and round-trips to null', () => {
    expect(variantPriceToField(null)).toBe('');
    expect(variantFieldToPrice(variantPriceToField(null))).toBeNull();
  });

  it('an override round-trips through the KWD field', () => {
    expect(variantPriceToField(4500)).toBe('4.500');
    expect(variantFieldToPrice('4.500')).toBe(4500);
    expect(variantFieldToPrice('  ')).toBeNull();
  });
});
