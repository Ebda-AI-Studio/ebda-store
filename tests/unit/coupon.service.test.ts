/**
 * Coupon service — unit tests.
 *
 * `evaluateForCart` is pure (runs the shared promotion-targeting evaluator
 * against a coupon's targeting fields) — no Prisma mock needed for it.
 */
import { describe, it, expect } from 'vitest';

import { CouponService } from '../../apps/api/src/services/coupon.service';

describe('CouponService.evaluateForCart', () => {
  const baseCoupon = {
    type: 'percentage' as const,
    value: 10,
    maxDiscount: null,
    customerGroupId: 'g1',
    firstOrderOnly: false,
    minOrderAmount: null,
    minQuantity: null,
    scopeProductIds: [],
    scopeCategoryIds: [],
  };

  it('is ineligible when the coupon targets a group the customer is not in', () => {
    const result = CouponService.evaluateForCart(baseCoupon, {
      customerGroupId: 'g2',
      isFirstOrder: false,
      cartItems: [{ productId: 'p1', categoryIds: [], quantity: 1, lineTotal: 1000 }],
    });

    expect(result).toMatchObject({ eligible: false });
  });

  it('is eligible and computes the discount on the matching subtotal when untargeted', () => {
    const result = CouponService.evaluateForCart(
      { ...baseCoupon, customerGroupId: null },
      {
        customerGroupId: null,
        isFirstOrder: false,
        cartItems: [{ productId: 'p1', categoryIds: [], quantity: 1, lineTotal: 1000 }],
      }
    );

    expect(result).toMatchObject({ eligible: true, discount: 100 });
  });
});
