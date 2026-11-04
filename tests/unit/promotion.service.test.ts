/**
 * Promotion service — unit tests.
 *
 * Mirrors the customer-group.service.test.ts mock style. Covers the
 * value-validation invariant (percentage 0-100, fixed non-negative),
 * cross-tenant 404s on getById/update, and the create/list/delete/
 * toggleActive CRUD shape.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// vi.mock is hoisted above every top-level statement, so its factory cannot
// close over ordinary consts. vi.hoisted lifts the mock with it.
const { mockPromotion, mockSearchNameIds } = vi.hoisted(() => ({
  mockSearchNameIds: vi.fn(),
  mockPromotion: {
    findMany: vi.fn(),
    findFirst: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    count: vi.fn(),
  },
}));

vi.mock('@ebda/database', () => ({
  prisma: {
    promotion: mockPromotion,
    // BE:S-25: the targeted customer group must belong to the store
    customerGroup: { findFirst: vi.fn().mockResolvedValue({ id: 'g1' }) },
  },
}));
// The Arabic-normalised name search is raw SQL (covered by
// tests/integration/product-search-normalised.test.ts); here only its wiring.
vi.mock('../../apps/api/src/services/product-search.service', () => ({
  searchNameIds: mockSearchNameIds,
}));

import { PromotionService } from '../../apps/api/src/services/promotion.service';
import { createSchema } from '../../apps/api/src/routes/promotion.routes';

const STORE = 'store-1';

beforeEach(() => {
  vi.clearAllMocks();
});

// Fix A regression: free_shipping is a valid CouponType but promotions have
// no shipping-line handler and resolveBestPromotion excludes the type
// outright, so a free_shipping promotion would silently never apply. The
// admin schema boundary must reject it outright (free_shipping COUPONS are
// unaffected and are validated by a separate schema).
describe('promotion createSchema — free_shipping rejection', () => {
  it('rejects type: free_shipping', () => {
    const result = createSchema.safeParse({
      name: 'Free shipping promo',
      type: 'free_shipping',
      value: 0,
    });

    expect(result.success).toBe(false);
  });

  it('still accepts percentage and fixed types', () => {
    expect(createSchema.safeParse({ name: 'Sale', type: 'percentage', value: 10 }).success).toBe(
      true
    );
    expect(createSchema.safeParse({ name: 'Sale', type: 'fixed', value: 500 }).success).toBe(true);
  });
});

describe('PromotionService.create', () => {
  it('rejects value>100 for percentage type', async () => {
    await expect(
      PromotionService.create(STORE, { name: 'x', type: 'percentage', value: 150 })
    ).rejects.toMatchObject({ statusCode: 400 });

    expect(mockPromotion.create).not.toHaveBeenCalled();
  });

  it('rejects a negative value for fixed type', async () => {
    await expect(
      PromotionService.create(STORE, { name: 'x', type: 'fixed', value: -10 })
    ).rejects.toMatchObject({ statusCode: 400 });

    expect(mockPromotion.create).not.toHaveBeenCalled();
  });

  it('defaults scopeProductIds/scopeCategoryIds to empty arrays when omitted', async () => {
    mockPromotion.create.mockResolvedValue({ id: 'p1' });

    await PromotionService.create(STORE, { name: 'Sale', type: 'percentage', value: 10 });

    expect(mockPromotion.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        storeId: STORE,
        scopeProductIds: [],
        scopeCategoryIds: [],
      }),
    });
  });

  it('persists the given scope arrays and targeting fields', async () => {
    mockPromotion.create.mockResolvedValue({ id: 'p1' });

    await PromotionService.create(STORE, {
      name: 'VIP sale',
      type: 'fixed',
      value: 500,
      customerGroupId: 'g1',
      firstOrderOnly: true,
      minOrderAmount: 1000,
      minQuantity: 2,
      scopeProductIds: ['prod-1'],
      scopeCategoryIds: ['cat-1'],
    });

    expect(mockPromotion.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        customerGroupId: 'g1',
        firstOrderOnly: true,
        minOrderAmount: 1000,
        minQuantity: 2,
        scopeProductIds: ['prod-1'],
        scopeCategoryIds: ['cat-1'],
      }),
    });
  });
});

describe('PromotionService.getById', () => {
  it('404s for a promotion belonging to another store', async () => {
    mockPromotion.findFirst.mockResolvedValue(null);

    await expect(PromotionService.getById(STORE, 'nope')).rejects.toMatchObject({
      statusCode: 404,
    });
  });

  it('returns the promotion when it belongs to the store', async () => {
    mockPromotion.findFirst.mockResolvedValue({ id: 'p1', storeId: STORE });

    const promotion = await PromotionService.getById(STORE, 'p1');

    expect(promotion).toMatchObject({ id: 'p1' });
    expect(mockPromotion.findFirst).toHaveBeenCalledWith({
      where: { id: 'p1', storeId: STORE },
    });
  });
});

describe('PromotionService.update', () => {
  it('404s for a cross-tenant promotion before writing', async () => {
    mockPromotion.findFirst.mockResolvedValue(null);

    await expect(PromotionService.update(STORE, 'nope', { name: 'y' })).rejects.toMatchObject({
      statusCode: 404,
    });

    expect(mockPromotion.update).not.toHaveBeenCalled();
  });

  it('validates the merged type/value when only value changes', async () => {
    mockPromotion.findFirst.mockResolvedValue({
      id: 'p1',
      storeId: STORE,
      type: 'percentage',
      value: 10,
    });

    await expect(PromotionService.update(STORE, 'p1', { value: 200 })).rejects.toMatchObject({
      statusCode: 400,
    });

    expect(mockPromotion.update).not.toHaveBeenCalled();
  });

  it('updates the promotion when validation passes', async () => {
    mockPromotion.findFirst.mockResolvedValue({
      id: 'p1',
      storeId: STORE,
      type: 'percentage',
      value: 10,
    });
    mockPromotion.update.mockResolvedValue({ id: 'p1', value: 20 });

    const result = await PromotionService.update(STORE, 'p1', { value: 20 });

    expect(mockPromotion.update).toHaveBeenCalledWith({
      where: { id: 'p1', storeId: STORE },
      data: expect.objectContaining({ value: 20 }),
    });
    expect(result).toMatchObject({ id: 'p1', value: 20 });
  });
});

describe('PromotionService.delete', () => {
  it('404s for a cross-tenant promotion before deleting', async () => {
    mockPromotion.findFirst.mockResolvedValue(null);

    await expect(PromotionService.delete(STORE, 'nope')).rejects.toMatchObject({
      statusCode: 404,
    });

    expect(mockPromotion.delete).not.toHaveBeenCalled();
  });

  it('deletes the promotion after the tenant check passes', async () => {
    mockPromotion.findFirst.mockResolvedValue({ id: 'p1', storeId: STORE });

    await PromotionService.delete(STORE, 'p1');

    expect(mockPromotion.delete).toHaveBeenCalledWith({
      where: { id: 'p1', storeId: STORE },
    });
  });
});

describe('PromotionService.toggleActive', () => {
  it('flips isActive', async () => {
    mockPromotion.findFirst.mockResolvedValue({ id: 'p1', storeId: STORE, isActive: true });
    mockPromotion.update.mockResolvedValue({ id: 'p1', isActive: false });

    const result = await PromotionService.toggleActive(STORE, 'p1');

    expect(mockPromotion.update).toHaveBeenCalledWith({
      where: { id: 'p1', storeId: STORE },
      data: { isActive: false },
    });
    expect(result).toMatchObject({ isActive: false });
  });
});

describe('PromotionService.list', () => {
  it('orders by priority desc then createdAt desc, with pagination', async () => {
    mockPromotion.findMany.mockResolvedValue([]);
    mockPromotion.count.mockResolvedValue(0);

    await PromotionService.list(STORE, { page: 2, limit: 10 });

    expect(mockPromotion.findMany).toHaveBeenCalledWith({
      where: { storeId: STORE },
      skip: 10,
      take: 10,
      orderBy: [{ priority: 'desc' }, { createdAt: 'desc' }],
    });
  });

  it('applies isActive filter and the normalised name/nameAr search as an id set', async () => {
    mockPromotion.findMany.mockResolvedValue([]);
    mockPromotion.count.mockResolvedValue(0);
    mockSearchNameIds.mockResolvedValue(['promo-1']);

    await PromotionService.list(STORE, { isActive: true, search: 'summer' });

    expect(mockSearchNameIds).toHaveBeenCalledWith('promotions', STORE, 'summer');
    expect(mockPromotion.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { storeId: STORE, isActive: true, id: { in: ['promo-1'] } },
      })
    );
  });
});
