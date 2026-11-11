// M-078 (Ruling PRICE-1): one coupon discount function behind every entry point. The same coupon, run through checkout /
// quote (evaluateForCart), admin order create (adminOrderCouponDiscount), the promotions resolver math and the Durable
// Object twin, must give identical totals, including for stored values the old duplicate copies disagreed on.
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../lib/repo-factory', () => ({ storeDb: vi.fn(), storeWriter: vi.fn() }));

import { CouponService } from '../coupon.service';
import * as apiMath from '../promotion-targeting';
import * as doMath from '../../../../../packages/repo/src/do/promotions';
import * as shared from '@ebda/shared';

const items = [
  { productId: 'p1', categoryIds: ['c1'], quantity: 2, lineTotal: 20_000 },
  { productId: 'p2', categoryIds: ['c2'], quantity: 1, lineTotal: 5_000 },
];
const ctx = { customerGroupId: null, isFirstOrder: true, cartItems: items };
const base = {
  customerGroupId: null,
  firstOrderOnly: false,
  minOrderAmount: null,
  minQuantity: null,
  scopeProductIds: [] as string[],
  scopeCategoryIds: [] as string[],
};
type T = 'percentage' | 'fixed' | 'free_shipping';
const coupons: Array<
  [string, { type: T; value: number; maxDiscount: number | null } & typeof base]
> = [
  ['10 percent', { ...base, type: 'percentage', value: 10, maxDiscount: null }],
  ['percent capped', { ...base, type: 'percentage', value: 50, maxDiscount: 3_000 }],
  ['percent cap 0 = no cap', { ...base, type: 'percentage', value: 50, maxDiscount: 0 }],
  ['legacy percent 250', { ...base, type: 'percentage', value: 250, maxDiscount: null }],
  ['fixed under goods', { ...base, type: 'fixed', value: 4_000, maxDiscount: null }],
  ['fixed above goods', { ...base, type: 'fixed', value: 90_000, maxDiscount: null }],
  [
    'scoped to p2',
    { ...base, type: 'percentage', value: 20, maxDiscount: null, scopeProductIds: ['p2'] },
  ],
  ['negative fixed (legacy row)', { ...base, type: 'fixed', value: -5_000, maxDiscount: null }],
  ['negative percent (legacy row)', { ...base, type: 'percentage', value: -10, maxDiscount: null }],
  ['NaN value', { ...base, type: 'fixed', value: Number.NaN, maxDiscount: null }],
  ['free shipping', { ...base, type: 'free_shipping', value: 0, maxDiscount: null }],
];

describe('M-078: one coupon discount source behind every entry point', () => {
  it.each(coupons)('%s prices identically everywhere', (_n, c) => {
    const fromCheckoutAndQuote = CouponService.evaluateForCart(c, ctx).discount;
    const fromAdminOrder = CouponService.adminOrderCouponDiscount(c, ctx, 25_000, false);
    const fromShared = shared.couponCartDiscount(c, ctx).discount;
    const matched = doMath.matchesTargeting(c, ctx);
    const fromDo = doMath.computeDiscount(c.type, c.value, c.maxDiscount, matched.matchingSubtotal);
    const fromPromotions = apiMath.computeDiscount(
      c.type,
      c.value,
      c.maxDiscount,
      matched.matchingSubtotal
    );
    const fromLegacyCalc = CouponService.calculateDiscount(c, matched.matchingSubtotal);
    for (const v of [fromAdminOrder, fromShared, fromDo, fromPromotions, fromLegacyCalc]) {
      expect(v).toBe(fromCheckoutAndQuote);
    }
    // never a surcharge, never more than the goods, always whole piastres
    expect(fromCheckoutAndQuote).toBeGreaterThanOrEqual(0);
    expect(fromCheckoutAndQuote).toBeLessThanOrEqual(matched.matchingSubtotal);
    expect(Number.isInteger(fromCheckoutAndQuote)).toBe(true);
  });

  it('a negative or NaN stored value never discounts below zero (old API copy returned the negative)', () => {
    expect(apiMath.computeDiscount('fixed', -5_000, null, 25_000)).toBe(0);
    expect(apiMath.computeDiscount('percentage', -10, null, 25_000)).toBe(0);
    expect(apiMath.computeDiscount('fixed', Number.NaN, null, 25_000)).toBe(0);
  });

  it('admin override uses the same function: the scope is kept, the gates are ignored', () => {
    const c = {
      ...base,
      type: 'percentage' as T,
      value: 20,
      maxDiscount: null,
      scopeProductIds: ['p2'],
      minOrderAmount: 999_999,
    };
    expect(CouponService.adminOrderCouponDiscount(c, ctx, 25_000, true)).toBe(1_000);
    expect(
      shared.couponCartDiscount(c, ctx, { override: true, overrideBase: 25_000 }).discount
    ).toBe(1_000);
  });
});
