/**
 * QA-PRICE-ZERO-1: no free active product / variant, no valueless coupon.
 * Pure guards (lib/sellable-price) plus the CouponService create/update/getByCode wiring (mocked Prisma, no DB).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    coupon: { findFirst: vi.fn(), create: vi.fn(), update: vi.fn() },
  },
}));
vi.mock('@ebda/database', () => ({ prisma: mockPrisma, Prisma: {} }));

import {
  assertActiveProductPrice,
  assertActiveVariantPrice,
  assertCouponValue,
  isFreeActiveProduct,
  isValidCouponValue,
} from '../../apps/api/src/lib/sellable-price';
import { CouponService } from '../../apps/api/src/services/coupon.service';

describe('active product price', () => {
  it('refuses an ACTIVE product at 0 with an Egyptian-Arabic message in details', () => {
    expect.assertions(3);
    try {
      assertActiveProductPrice({ status: 'active', price: 0 });
    } catch (e) {
      const err = e as { statusCode: number; code: string; details: { messageAr: string } };
      expect(err.statusCode).toBe(400);
      expect(err.code).toBe('PRICE_REQUIRED_FOR_ACTIVE');
      expect(err.details.messageAr).toMatch(/أكبر من صفر/);
    }
  });
  it('allows a draft or archived placeholder at 0, an active product above 0', () => {
    expect(() => assertActiveProductPrice({ status: 'draft', price: 0 })).not.toThrow();
    expect(() => assertActiveProductPrice({ status: 'archived', price: 0 })).not.toThrow();
    expect(() => assertActiveProductPrice({ status: 'active', price: 1 })).not.toThrow();
  });
  it('does not trip the gold repricer (gold_rate rows are priced by the repricer) nor a variant product', () => {
    expect(isFreeActiveProduct({ status: 'active', price: 0, pricingMode: 'gold_rate' })).toBe(
      false
    );
    expect(isFreeActiveProduct({ status: 'active', price: 0, hasVariants: true })).toBe(false);
  });
  it('treats a missing / negative / NaN price on an active product as free', () => {
    expect(isFreeActiveProduct({ status: 'active' })).toBe(true);
    expect(isFreeActiveProduct({ status: 'active', price: -5 })).toBe(true);
    expect(isFreeActiveProduct({ status: 'active', price: Number.NaN })).toBe(true);
  });
});

describe('active variant price', () => {
  it('judges the effective price: own override, else the product price', () => {
    expect(() => assertActiveVariantPrice({ price: 0, productPrice: 5000 })).toThrow(/above zero/);
    expect(() => assertActiveVariantPrice({ price: null, productPrice: 0 })).toThrow(/above zero/);
    expect(() => assertActiveVariantPrice({ price: null, productPrice: 5000 })).not.toThrow();
    expect(() => assertActiveVariantPrice({ price: 100, productPrice: 0 })).not.toThrow();
  });
  it('skips a disabled variant and a gold-rate product / variant', () => {
    expect(() => assertActiveVariantPrice({ isActive: false, price: 0 })).not.toThrow();
    expect(() =>
      assertActiveVariantPrice({ price: 0, productPricingMode: 'gold_rate' })
    ).not.toThrow();
    expect(() =>
      assertActiveVariantPrice({ price: 0, variantPricingMode: 'gold_rate' })
    ).not.toThrow();
  });
});

describe('coupon value', () => {
  it('percentage and fixed need a value above zero; 100% (a giveaway) is allowed, above 100 is not; free_shipping has none', () => {
    expect(isValidCouponValue('percentage', 0)).toBe(false);
    expect(isValidCouponValue('percentage', 100)).toBe(true);
    expect(isValidCouponValue('percentage', 101)).toBe(false);
    expect(isValidCouponValue('percentage', -5)).toBe(false);
    expect(isValidCouponValue('fixed', -1)).toBe(false);
    expect(isValidCouponValue('percentage', 20)).toBe(true);
    expect(isValidCouponValue('fixed', 0)).toBe(false);
    expect(isValidCouponValue('fixed', 5000)).toBe(true);
    expect(isValidCouponValue('free_shipping', 0)).toBe(true);
    expect(isValidCouponValue('percentage', Number.NaN)).toBe(false);
    expect(() => assertCouponValue('percentage', 0)).toThrow(/above zero/);
  });
});

describe('CouponService wiring', () => {
  beforeEach(() => vi.clearAllMocks());
  const base = { code: 'QA20', name: 'QA 20' } as never;

  it('create refuses a 0% coupon before touching the database', async () => {
    await expect(
      CouponService.create('s1', { ...base, type: 'percentage', value: 0 } as never)
    ).rejects.toMatchObject({ code: 'COUPON_VALUE_REQUIRED' });
    expect(mockPrisma.coupon.create).not.toHaveBeenCalled();
  });

  it('update judges the type/value pair the row will have: a value-only 0 on a stored percentage coupon is refused', async () => {
    mockPrisma.coupon.findFirst.mockResolvedValue({
      id: 'c1',
      storeId: 's1',
      type: 'percentage',
      value: 20,
    });
    await expect(CouponService.update('s1', 'c1', { value: 0 } as never)).rejects.toMatchObject({
      code: 'COUPON_VALUE_REQUIRED',
    });
    expect(mockPrisma.coupon.update).not.toHaveBeenCalled();
  });

  it('update of an unrelated field on a legacy 0-value coupon is not blocked (it only stops being usable at checkout)', async () => {
    mockPrisma.coupon.findFirst.mockResolvedValue({
      id: 'c1',
      storeId: 's1',
      type: 'percentage',
      value: 0,
    });
    mockPrisma.coupon.update.mockResolvedValue({ id: 'c1' });
    await expect(
      CouponService.update('s1', 'c1', { isActive: false } as never)
    ).resolves.toBeDefined();
  });

  it('getByCode (validate, quote and order all read here) refuses a stored 0-value coupon as not valid', async () => {
    mockPrisma.coupon.findFirst.mockResolvedValue({
      id: 'c1',
      code: 'QA20',
      type: 'percentage',
      value: 0,
      isActive: true,
      startsAt: null,
      expiresAt: null,
      usageLimit: null,
      usageCount: 0,
    });
    await expect(CouponService.getByCode('s1', 'QA20')).rejects.toMatchObject({
      code: 'COUPON_VALUE_REQUIRED',
    });
  });
});

describe('QA-COUPON-1: validate, quote, order and the DO compute the SAME discount', () => {
  it('one formula across CouponService.calculateDiscount, computeDiscount (Postgres) and the DO twin, incl. cap 0 = no cap, 100% and fixed over the subtotal', async () => {
    const { computeDiscount } = await import('../../apps/api/src/services/promotion-targeting');
    const { computeDiscount: doCompute } = await import('../../packages/repo/src/do/promotions');
    const types = ['percentage', 'fixed', 'free_shipping'] as const;
    for (const type of types)
      for (const value of [1, 20, 100, 5000])
        for (const max of [null, 0, 300, 100_000])
          for (const base of [0, 450, 45_000]) {
            const a = CouponService.calculateDiscount({ type, value, maxDiscount: max }, base);
            expect(a).toBe(computeDiscount(type, value, max, base));
            expect(a).toBe(doCompute(type, value, max, base));
            expect(a).toBeLessThanOrEqual(base);
          }
    expect(
      CouponService.calculateDiscount({ type: 'percentage', value: 20, maxDiscount: 0 }, 45_000)
    ).toBe(9_000);
    expect(
      CouponService.calculateDiscount({ type: 'percentage', value: 100, maxDiscount: null }, 45_000)
    ).toBe(45_000);
    expect(
      CouponService.calculateDiscount({ type: 'fixed', value: 99_999, maxDiscount: null }, 45_000)
    ).toBe(45_000);
  });
});
