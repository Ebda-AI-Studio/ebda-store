// packages/shared/src/utils/discount.test.ts
import { describe, it, expect } from 'vitest';
import { computeDiscountAmount, applyDiscount, deriveDiscountInput } from './discount';

// ─────────────────────────────────────────────────────────────────────────────
// computeDiscountAmount
// ─────────────────────────────────────────────────────────────────────────────

describe('computeDiscountAmount', () => {
  it('percentage: 10% of 5 000 fils = 500 fils', () => {
    // 10% = 1000 basis points
    expect(computeDiscountAmount(5000, 'percentage', 1000)).toBe(500);
  });

  it('percentage: 12.5% of 10 000 fils = 1 250 fils', () => {
    // 12.5% = 1250 basis points
    expect(computeDiscountAmount(10000, 'percentage', 1250)).toBe(1250);
  });

  it('percentage: rounds fractional fils', () => {
    // 33.33% of 10 fils — 0.3333 fils rounds to 0
    expect(computeDiscountAmount(10, 'percentage', 3333)).toBe(3);
  });

  it('fixed: passes the value through', () => {
    expect(computeDiscountAmount(5000, 'fixed', 1500)).toBe(1500);
  });

  it('clamps discount to 0 when value is 0', () => {
    expect(computeDiscountAmount(5000, 'percentage', 0)).toBe(0);
    expect(computeDiscountAmount(5000, 'fixed', 0)).toBe(0);
  });

  it('clamps discount to regularPrice when value exceeds it (fixed)', () => {
    // Fixed discount larger than regular price → clamped to regular price
    expect(computeDiscountAmount(500, 'fixed', 9999)).toBe(500);
  });

  it('clamps percentage discount to 100% (10 000 bp)', () => {
    // 200% in basis points → amount clamped to regular price
    expect(computeDiscountAmount(5000, 'percentage', 20000)).toBe(5000);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// applyDiscount
// ─────────────────────────────────────────────────────────────────────────────

describe('applyDiscount', () => {
  it('percentage discount: sets price and compareAtPrice correctly', () => {
    const result = applyDiscount(10000, 'percentage', 2000); // 20% off
    expect(result.price).toBe(8000);
    expect(result.compareAtPrice).toBe(10000);
  });

  it('fixed discount: reduces price and preserves compareAtPrice', () => {
    const result = applyDiscount(5000, 'fixed', 1000);
    expect(result.price).toBe(4000);
    expect(result.compareAtPrice).toBe(5000);
  });

  it('zero discount: no compareAtPrice set', () => {
    const result = applyDiscount(5000, 'fixed', 0);
    expect(result.price).toBe(5000);
    expect(result.compareAtPrice).toBeNull();
  });

  it('100% percentage discount (clamped): no compareAtPrice set', () => {
    // Full 100% off = price would be 0 = amount === regularPrice → no split
    const result = applyDiscount(5000, 'percentage', 10000);
    expect(result.price).toBe(5000);
    expect(result.compareAtPrice).toBeNull();
  });

  it('fixed discount equal to price (clamped): no compareAtPrice set', () => {
    const result = applyDiscount(3000, 'fixed', 3000);
    expect(result.price).toBe(3000);
    expect(result.compareAtPrice).toBeNull();
  });

  it('round-trip: applyDiscount → deriveDiscountInput recovers original values', () => {
    const regularPrice = 8000;
    const type = 'percentage' as const;
    const value = 1500; // 15%

    const { price, compareAtPrice } = applyDiscount(regularPrice, type, value);
    const derived = deriveDiscountInput({
      price,
      compareAtPrice,
      discountType: type,
      discountValue: value,
    });

    expect(derived.regularPrice).toBe(regularPrice);
    expect(derived.type).toBe(type);
    expect(derived.value).toBe(value);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// deriveDiscountInput
// ─────────────────────────────────────────────────────────────────────────────

describe('deriveDiscountInput', () => {
  it('reads new columns when present (percentage)', () => {
    const result = deriveDiscountInput({
      price: 8500,
      compareAtPrice: 10000,
      discountType: 'percentage',
      discountValue: 1500,
    });
    expect(result.regularPrice).toBe(10000);
    expect(result.type).toBe('percentage');
    expect(result.value).toBe(1500);
  });

  it('reads new columns when present (fixed)', () => {
    const result = deriveDiscountInput({
      price: 4000,
      compareAtPrice: 5000,
      discountType: 'fixed',
      discountValue: 1000,
    });
    expect(result.regularPrice).toBe(5000);
    expect(result.type).toBe('fixed');
    expect(result.value).toBe(1000);
  });

  it('legacy compareAtPrice > price → infers fixed discount', () => {
    const result = deriveDiscountInput({
      price: 4500,
      compareAtPrice: 6000,
      discountType: null,
      discountValue: null,
    });
    expect(result.regularPrice).toBe(6000);
    expect(result.type).toBe('fixed');
    expect(result.value).toBe(1500);
  });

  it('no discount → regularPrice = price, type = none', () => {
    const result = deriveDiscountInput({
      price: 3000,
      compareAtPrice: null,
      discountType: null,
      discountValue: null,
    });
    expect(result.regularPrice).toBe(3000);
    expect(result.type).toBe('none');
    expect(result.value).toBe(0);
  });

  it('compareAtPrice <= price → treated as no-discount', () => {
    // Storefront ignores compareAtPrice when it is not > price; same logic here.
    const result = deriveDiscountInput({
      price: 5000,
      compareAtPrice: 5000,
      discountType: null,
      discountValue: null,
    });
    expect(result.type).toBe('none');
  });

  it('missing compareAtPrice entirely → regularPrice = price', () => {
    const result = deriveDiscountInput({ price: 2000 });
    expect(result.regularPrice).toBe(2000);
    expect(result.type).toBe('none');
  });
});
