import { describe, it, expect } from 'vitest';
import { matchesTargeting, computeDiscount } from '../../apps/api/src/services/promotion-targeting';

const item = (
  o: Partial<{ productId: string; categoryIds: string[]; quantity: number; lineTotal: number }> = {}
) => ({
  productId: o.productId ?? 'p1',
  categoryIds: o.categoryIds ?? ['c1'],
  quantity: o.quantity ?? 1,
  lineTotal: o.lineTotal ?? 1000,
});
const base = {
  customerGroupId: null,
  firstOrderOnly: false,
  minOrderAmount: null,
  minQuantity: null,
  scopeProductIds: [],
  scopeCategoryIds: [],
};
const ctx = (
  o: Partial<{
    customerGroupId: string | null;
    isFirstOrder: boolean;
    cartItems: ReturnType<typeof item>[];
  }> = {}
) => ({
  customerGroupId: o.customerGroupId ?? null,
  isFirstOrder: o.isFirstOrder ?? false,
  cartItems: o.cartItems ?? [item()],
});

describe('matchesTargeting', () => {
  it('matches everyone / whole cart when untargeted', () => {
    const r = matchesTargeting(
      base,
      ctx({ cartItems: [item({ lineTotal: 1000 }), item({ productId: 'p2', lineTotal: 500 })] })
    );
    expect(r).toEqual({ eligible: true, matchingSubtotal: 1500, matchingQty: 2 });
  });
  it('requires the customer to be in the targeted group', () => {
    expect(
      matchesTargeting({ ...base, customerGroupId: 'g1' }, ctx({ customerGroupId: 'g1' })).eligible
    ).toBe(true);
    expect(
      matchesTargeting({ ...base, customerGroupId: 'g1' }, ctx({ customerGroupId: 'g2' })).eligible
    ).toBe(false);
    expect(
      matchesTargeting({ ...base, customerGroupId: 'g1' }, ctx({ customerGroupId: null })).eligible
    ).toBe(false);
  });
  it('enforces first-order-only', () => {
    expect(
      matchesTargeting({ ...base, firstOrderOnly: true }, ctx({ isFirstOrder: true })).eligible
    ).toBe(true);
    expect(
      matchesTargeting({ ...base, firstOrderOnly: true }, ctx({ isFirstOrder: false })).eligible
    ).toBe(false);
  });
  it('scopes the subtotal to matching products only', () => {
    const r = matchesTargeting(
      { ...base, scopeProductIds: ['p1'] },
      ctx({
        cartItems: [
          item({ productId: 'p1', lineTotal: 1000 }),
          item({ productId: 'p2', lineTotal: 500 }),
        ],
      })
    );
    expect(r).toEqual({ eligible: true, matchingSubtotal: 1000, matchingQty: 1 });
  });
  it('scopes by category', () => {
    const r = matchesTargeting(
      { ...base, scopeCategoryIds: ['c2'] },
      ctx({
        cartItems: [
          item({ categoryIds: ['c1'], lineTotal: 1000 }),
          item({ productId: 'p2', categoryIds: ['c2'], lineTotal: 700 }),
        ],
      })
    );
    expect(r).toEqual({ eligible: true, matchingSubtotal: 700, matchingQty: 1 });
  });
  it('unions product and category scope when both are set', () => {
    // p1 matches by product, p2 matches by category, p3 matches neither.
    const r = matchesTargeting(
      { ...base, scopeProductIds: ['p1'], scopeCategoryIds: ['cSummer'] },
      ctx({
        cartItems: [
          item({ productId: 'p1', categoryIds: ['cOther'], lineTotal: 1000 }),
          item({ productId: 'p2', categoryIds: ['cSummer'], lineTotal: 700 }),
          item({ productId: 'p3', categoryIds: ['cOther'], lineTotal: 300 }),
        ],
      })
    );
    expect(r).toEqual({ eligible: true, matchingSubtotal: 1700, matchingQty: 2 });
  });
  it('gates min order amount on the matching subtotal, not the whole cart', () => {
    // Whole cart is 1500 but only p1 (1000) is in scope, below the 1200 gate.
    expect(
      matchesTargeting(
        { ...base, scopeProductIds: ['p1'], minOrderAmount: 1200 },
        ctx({
          cartItems: [
            item({ productId: 'p1', lineTotal: 1000 }),
            item({ productId: 'p2', lineTotal: 500 }),
          ],
        })
      ).eligible
    ).toBe(false);
  });
  it('is ineligible when a scope matches nothing', () => {
    expect(matchesTargeting({ ...base, scopeProductIds: ['pX'] }, ctx()).eligible).toBe(false);
  });
  it('gates on min order amount (matching subtotal) and min quantity', () => {
    expect(
      matchesTargeting(
        { ...base, minOrderAmount: 2000 },
        ctx({ cartItems: [item({ lineTotal: 1500 })] })
      ).eligible
    ).toBe(false);
    expect(
      matchesTargeting({ ...base, minQuantity: 3 }, ctx({ cartItems: [item({ quantity: 2 })] }))
        .eligible
    ).toBe(false);
    expect(
      matchesTargeting({ ...base, minQuantity: 3 }, ctx({ cartItems: [item({ quantity: 3 })] }))
        .eligible
    ).toBe(true);
  });
});

describe('computeDiscount', () => {
  it('percentage, capped by maxDiscount', () => {
    expect(computeDiscount('percentage', 10, null, 1000)).toBe(100);
    expect(computeDiscount('percentage', 50, 200, 1000)).toBe(200);
  });
  it('fixed, clamped to base', () => {
    expect(computeDiscount('fixed', 300, null, 1000)).toBe(300);
    expect(computeDiscount('fixed', 5000, null, 1000)).toBe(1000);
  });
  it('free_shipping yields no line discount', () => {
    expect(computeDiscount('free_shipping', 0, null, 1000)).toBe(0);
  });
});
