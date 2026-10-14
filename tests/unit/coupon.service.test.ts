/**
 * Coupon service — unit tests.
 *
 * `evaluateForCart` is pure (runs the shared promotion-targeting evaluator
 * against a coupon's targeting fields) — no Prisma mock needed for it.
 * `getByCode` does read Prisma, so it gets a minimal mock below (never a real
 * DB connection).
 */
import { describe, it, expect, vi } from 'vitest';

const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: { coupon: { findFirst: vi.fn() } },
}));

vi.mock('@ebda/database', () => ({
  prisma: mockPrisma,
  Prisma: {},
}));

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

  // CLEAR-1's behavioural pair: clearing minOrderAmount must make the coupon
  // MORE permissive, not less. If a NULL were ever read as "minimum 0" this
  // would still pass (0 <= subtotal too) — the real regression to guard
  // against is `.min(0)` /Zod coercion turning a cleared field into 0 instead
  // of leaving it unset, which is why the schema test above asserts `null`
  // specifically, not just "falsy".
  it('an order rejected by minOrderAmount is accepted once it is cleared to null', () => {
    const ctx = {
      customerGroupId: null,
      isFirstOrder: false,
      cartItems: [{ productId: 'p1', categoryIds: [], quantity: 1, lineTotal: 1000 }],
    };
    const withMinimum = { ...baseCoupon, customerGroupId: null, minOrderAmount: 5000 };

    expect(CouponService.evaluateForCart(withMinimum, ctx)).toMatchObject({ eligible: false });
    expect(
      CouponService.evaluateForCart({ ...withMinimum, minOrderAmount: null }, ctx)
    ).toMatchObject({ eligible: true });
  });
});

describe('CouponService.getByCode — a cleared expiresAt is more permissive, not less', () => {
  const STORED = {
    id: 'coupon-1',
    storeId: 'store-1',
    code: 'SUMMER',
    isActive: true,
    startsAt: null,
    usageLimit: null,
    usageCount: 0,
  };

  it('rejects a coupon with a past expiresAt as expired', async () => {
    mockPrisma.coupon.findFirst.mockResolvedValue({
      ...STORED,
      expiresAt: new Date(Date.now() - 60_000),
    });

    await expect(CouponService.getByCode('store-1', 'SUMMER')).rejects.toMatchObject({
      code: 'COUPON_EXPIRED',
    });
  });

  it('is not expired once expiresAt is cleared to null (the fix)', async () => {
    mockPrisma.coupon.findFirst.mockResolvedValue({ ...STORED, expiresAt: null });

    await expect(CouponService.getByCode('store-1', 'SUMMER')).resolves.toMatchObject({
      code: 'SUMMER',
    });
  });
});
