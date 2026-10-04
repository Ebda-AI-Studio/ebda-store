// packages/shared/src/utils/minimum-order.test.ts
import { describe, it, expect } from 'vitest';
import { checkMinimumOrder } from './minimum-order';

describe('checkMinimumOrder', () => {
  it('is not met when subtotal is below the minimum', () => {
    const result = checkMinimumOrder(3000, 5000);
    expect(result.met).toBe(false);
    expect(result.shortfallFils).toBe(2000);
  });

  it('is met when subtotal exactly equals the minimum', () => {
    const result = checkMinimumOrder(5000, 5000);
    expect(result.met).toBe(true);
    expect(result.shortfallFils).toBe(0);
  });

  it('is met when subtotal is above the minimum', () => {
    const result = checkMinimumOrder(7500, 5000);
    expect(result.met).toBe(true);
    expect(result.shortfallFils).toBe(0);
  });

  it('is always met when the minimum is 0 (unset)', () => {
    const result = checkMinimumOrder(0, 0);
    expect(result.met).toBe(true);
    expect(result.shortfallFils).toBe(0);
  });

  it('is always met when the minimum is undefined', () => {
    const result = checkMinimumOrder(100, undefined);
    expect(result.met).toBe(true);
    expect(result.shortfallFils).toBe(0);
  });

  it('is always met when the minimum is null', () => {
    const result = checkMinimumOrder(100, null);
    expect(result.met).toBe(true);
    expect(result.shortfallFils).toBe(0);
  });

  it('treats a negative minimum defensively as unset', () => {
    const result = checkMinimumOrder(0, -5000);
    expect(result.met).toBe(true);
    expect(result.shortfallFils).toBe(0);
  });

  it('computes the exact Pecannbee scenario (5 EGP minimum, 2 EGP short)', () => {
    // 5 EGP = 5000 piastres minimum, cart at 3 EGP = 3000 piastres.
    const result = checkMinimumOrder(3000, 5000);
    expect(result.met).toBe(false);
    expect(result.shortfallFils).toBe(2000); // 2.000 EGP more needed
  });

  it('is not met for a subtotal of 0 against a positive minimum', () => {
    const result = checkMinimumOrder(0, 5000);
    expect(result.met).toBe(false);
    expect(result.shortfallFils).toBe(5000);
  });
});
