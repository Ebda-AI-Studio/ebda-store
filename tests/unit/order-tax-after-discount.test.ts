import { describe, it, expect } from 'vitest';
import { computeOrderTax } from '@api/lib/order-tax';

describe('computeOrderTax — VAT after discount (#193)', () => {
  it('taxes the subtotal net of the discount', () => {
    expect(computeOrderTax(20000, 5000, 0.05)).toBe(750); // not 1000
  });

  it('rounds half away from zero to the fil, once', () => {
    // 15% coupon on 7990: base 6792 (7990 − 1198) × 5% = 339.6 → 340.
    expect(computeOrderTax(7990, 1198, 0.05)).toBe(340);
    expect(computeOrderTax(1010, 0, 0.05)).toBe(51); // 50.5 → 51
  });

  it('never goes negative when the discount exceeds the subtotal', () => {
    expect(computeOrderTax(1000, 1500, 0.05)).toBe(0);
  });

  it('is zero for a store with tax off', () => {
    expect(computeOrderTax(20000, 0, 0)).toBe(0);
    expect(computeOrderTax(20000, 5000, 0)).toBe(0);
  });
});
