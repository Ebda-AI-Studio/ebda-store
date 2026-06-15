/**
 * Loyalty redemption math — pure unit tests for computeRedemption.
 *
 * computeRedemption is the SERVER-SIDE source of truth that turns a customer's
 * *requested* point count into the points actually burned + the discount in
 * fils. It never trusts a client-sent discount. These tests pin the money
 * rules: minimum gate, balance clamp, subtotal cap, percentage cap, and that
 * the burned points always equal discount / pointsValue exactly (no orphaned
 * points). All money is in fils (integers).
 */

import { describe, it, expect } from 'vitest';
import { computeRedemption, DEFAULT_LOYALTY_SETTINGS } from '@api/services/loyalty.service';

// Base settings: 1 fil per point, min 500 points, 50% max of order.
const settings = {
  ...DEFAULT_LOYALTY_SETTINGS,
  pointsValue: 1,
  minRedeemPoints: 500,
  maxRedeemPercentage: 50,
};

describe('computeRedemption', () => {
  it('redeems the requested points when within balance, minimum, and caps', () => {
    // 1000 points * 1 fil = 1000 fils discount; subtotal 10000, 50% cap = 5000
    const q = computeRedemption(settings, 1000, 10_000, 5000);
    expect(q.applied).toBe(true);
    expect(q.pointsToRedeem).toBe(1000);
    expect(q.discountFils).toBe(1000);
  });

  it('clamps the request to the available balance', () => {
    // Requests 5000 but only has 800 → burns 800.
    const q = computeRedemption(settings, 5000, 100_000, 800);
    expect(q.applied).toBe(true);
    expect(q.pointsToRedeem).toBe(800);
    expect(q.discountFils).toBe(800);
  });

  it('returns nothing below the minimum redeem points', () => {
    // Only 300 available, minimum is 500.
    const q = computeRedemption(settings, 300, 100_000, 300);
    expect(q.applied).toBe(false);
    expect(q.pointsToRedeem).toBe(0);
    expect(q.discountFils).toBe(0);
  });

  it('caps the discount at the subtotal and reduces burned points to match', () => {
    // pointsValue 10 fils, subtotal 3000 (3 KWD), 100% cap → discount capped
    // at 3000 fils → 300 points burned, not the 1000 requested.
    const s = { ...settings, pointsValue: 10, minRedeemPoints: 100, maxRedeemPercentage: 100 };
    const q = computeRedemption(s, 1000, 3000, 1000);
    expect(q.applied).toBe(true);
    expect(q.discountFils).toBe(3000);
    expect(q.pointsToRedeem).toBe(300); // 3000 / 10
    // Discount equals points * value exactly — no orphaned points.
    expect(q.discountFils).toBe(q.pointsToRedeem * 10);
  });

  it('caps the discount at maxRedeemPercentage of the subtotal', () => {
    // 50% of 10000 = 5000 fils cap. Customer has 9000 points @ 1 fil.
    const q = computeRedemption(settings, 9000, 10_000, 9000);
    expect(q.applied).toBe(true);
    expect(q.discountFils).toBe(5000);
    expect(q.pointsToRedeem).toBe(5000);
  });

  it('honors pointsValue > 1 fil per point', () => {
    // 5 fils/point, 600 points = 3000 fils; subtotal 10000, 50% = 5000 cap.
    const s = { ...settings, pointsValue: 5 };
    const q = computeRedemption(s, 600, 10_000, 600);
    expect(q.applied).toBe(true);
    expect(q.pointsToRedeem).toBe(600);
    expect(q.discountFils).toBe(3000);
  });

  it('returns nothing when the subtotal is zero', () => {
    const q = computeRedemption(settings, 1000, 0, 1000);
    expect(q.applied).toBe(false);
    expect(q.discountFils).toBe(0);
  });

  it('returns nothing when the cap pushes burned points below the minimum', () => {
    // 50% of a 600-fil subtotal = 300 fils cap → 300 points @ 1 fil, but the
    // minimum is 500 → nothing redeems rather than a sub-minimum amount.
    const q = computeRedemption(settings, 1000, 600, 1000);
    expect(q.applied).toBe(false);
    expect(q.pointsToRedeem).toBe(0);
  });

  it('ignores non-positive / non-finite requests (guest-ignored shape)', () => {
    expect(computeRedemption(settings, 0, 10_000, 1000).applied).toBe(false);
    expect(computeRedemption(settings, -500, 10_000, 1000).applied).toBe(false);
    expect(computeRedemption(settings, NaN, 10_000, 1000).applied).toBe(false);
  });

  it('floors fractional point caps (never over-discounts)', () => {
    // pointsValue 3 fils, 50% of 1000 = 500 fils cap → 166 points (498 fils),
    // floor() means we discount 498 not 500.
    const s = { ...settings, pointsValue: 3, minRedeemPoints: 1, maxRedeemPercentage: 50 };
    const q = computeRedemption(s, 1000, 1000, 1000);
    expect(q.pointsToRedeem).toBe(166);
    expect(q.discountFils).toBe(498);
    expect(q.discountFils).toBeLessThanOrEqual(500);
  });
});
