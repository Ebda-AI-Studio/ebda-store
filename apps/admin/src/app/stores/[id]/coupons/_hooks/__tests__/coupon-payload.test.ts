/**
 * #1569 — the coupon form's KWD money fields must round-trip.
 *
 * The edit form hydrates `minOrderAmount` / `maxDiscount` as fils / 1000
 * (page.tsx: `String(coupon.minOrderAmount / 1000)`), so a 5.500 KWD minimum
 * shows as "5.5". The save used `parseInt(v) * 1000`, which sent 5000: opening
 * a coupon and saving ANY unrelated change silently lowered its minimum order
 * (and its percentage cap) with no server-side guard.
 */
import { describe, it, expect } from 'vitest';
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
    value: 10,
    minOrderAmount: minOrderFils ? String(minOrderFils / 1000) : '',
    maxDiscount: maxDiscountFils ? String(maxDiscountFils / 1000) : '',
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

describe('buildCouponPayload — fractional KWD survives an edit-save', () => {
  it.each([
    [5500, 2250],
    [2500, 750],
    [290, 1],
    [12345, 999],
  ])('stored %i / %i fils → form → save sends the same fils', (minFils, maxFils) => {
    const body = buildCouponPayload(hydrate(minFils, maxFils), 'update');
    expect(body.minOrderAmount).toBe(minFils);
    expect(body.maxDiscount).toBe(maxFils);
  });

  it('whole-dinar values are unchanged (the only case parseInt got right)', () => {
    const body = buildCouponPayload(hydrate(5000, 3000), 'update');
    expect(body.minOrderAmount).toBe(5000);
    expect(body.maxDiscount).toBe(3000);
  });

  it('emptied fields still clear on update and stay absent on create', () => {
    expect(buildCouponPayload(hydrate(0, 0), 'update').minOrderAmount).toBeNull();
    expect(buildCouponPayload(hydrate(0, 0), 'create').maxDiscount).toBeUndefined();
  });

  it('a typed amount like 0.29 rounds to 290, not 289', () => {
    const form = { ...hydrate(0, 0), minOrderAmount: '0.29' };
    expect(buildCouponPayload(form, 'create').minOrderAmount).toBe(290);
  });
});
