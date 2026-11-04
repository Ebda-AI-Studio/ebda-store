/**
 * #1569 — the coupon form's EGP money fields must round-trip.
 *
 * The edit form hydrates `minOrderAmount` / `maxDiscount` as major units
 * (page.tsx: `String(fromMinor(coupon.minOrderAmount))`), so a 55.50 EGP minimum
 * shows as "55.5". The save used `parseInt(v) * 100`, which sent 5500 → 5000: opening
 * a coupon and saving ANY unrelated change silently lowered its minimum order
 * (and its percentage cap) with no server-side guard.
 */
import { describe, it, expect } from 'vitest';
import { fromMinor } from '@ebda/shared';
import { buildCouponPayload } from '../useCoupons';
import type { CouponFormData } from '../../_components/types';

/** Exactly what page.tsx builds when a stored coupon is opened for edit. */
function hydrate(minOrderFils: number, maxDiscountFils: number): CouponFormData {
  return {
    code: 'SAVE',
    name: 'Save',
    nameAr: '',
    description: '',
    descriptionAr: '',
    type: 'percentage',
    value: '10',
    minOrderAmount: minOrderFils ? String(fromMinor(minOrderFils)) : '',
    maxDiscount: maxDiscountFils ? String(fromMinor(maxDiscountFils)) : '',
    usageLimit: '',
    usageLimitPerUser: '',
    isActive: true,
    startsAt: '',
    expiresAt: '',
    customerGroupId: '',
    firstOrderOnly: false,
    minQuantity: '',
    scopeProductIds: [],
    scopeCategoryIds: [],
  };
}

describe('buildCouponPayload — fractional EGP survives an edit-save', () => {
  it.each([
    [5500, 2250],
    [2500, 750],
    [290, 1],
    [12345, 999],
  ])('stored %i / %i piastres → form → save sends the same piastres', (minFils, maxFils) => {
    const body = buildCouponPayload(hydrate(minFils, maxFils), 'update');
    expect(body.minOrderAmount).toBe(minFils);
    expect(body.maxDiscount).toBe(maxFils);
  });

  it('whole-pound values are unchanged (the only case parseInt got right)', () => {
    const body = buildCouponPayload(hydrate(5000, 3000), 'update');
    expect(body.minOrderAmount).toBe(5000);
    expect(body.maxDiscount).toBe(3000);
  });

  it('emptied fields still clear on update and stay absent on create', () => {
    expect(buildCouponPayload(hydrate(0, 0), 'update').minOrderAmount).toBeNull();
    expect(buildCouponPayload(hydrate(0, 0), 'create').maxDiscount).toBeUndefined();
  });

  it('a typed amount like 0.29 rounds to 29, not 28 (0.29 * 100 === 28.999999999999996)', () => {
    const form = { ...hydrate(0, 0), minOrderAmount: '0.29' };
    expect(buildCouponPayload(form, 'create').minOrderAmount).toBe(29);
  });
});
