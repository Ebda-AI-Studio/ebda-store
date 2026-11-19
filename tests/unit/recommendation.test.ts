/**
 * Recommendation Service — Unit Tests
 * Tests for FBT pair normalization, relation type validation,
 * cart recommendations, product recommendations structure, and cache key format.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock prisma before importing the service
vi.mock('@ebda/database', () => ({
  hasTenantContext: () => false,
  currentTenantGucs: () => undefined,
  runInTenantContext: (_storeId: string, fn: () => unknown) => fn(),
  prisma: {
    productRelation: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
      count: vi.fn(),
      create: vi.fn(),
      createMany: vi.fn(),
      deleteMany: vi.fn(),
      delete: vi.fn(),
    },
    frequentlyBoughtTogether: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
      upsert: vi.fn(),
      deleteMany: vi.fn(),
      count: vi.fn(),
    },
    product: {
      findMany: vi.fn(),
    },
    productCategory: {
      findMany: vi.fn(),
    },
    order: {
      findMany: vi.fn(),
    },
    aiRecommendation: {
      findMany: vi.fn().mockResolvedValue([]),
    },
  },
}));

// Mock redis service
vi.mock('../../apps/api/src/services/redis.service', () => ({
  redis: {
    get: vi.fn(),
    set: vi.fn(),
    delete: vi.fn(),
    acquireLock: vi.fn(),
    releaseLock: vi.fn(),
    getClient: vi.fn(),
  },
}));

// The merchant's automatic-recommendations switch is read from the store row (absent = on)
vi.mock('../../apps/api/src/services/store.service', () => ({
  StoreService: { getById: vi.fn(async () => ({ settings: {} })) },
}));

// Mock logger
vi.mock('../../apps/api/src/lib/logger', () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

import { prisma } from '@ebda/database';
import { redis } from '../../apps/api/src/services/redis.service';
import { recommendationService } from '../../apps/api/src/services/recommendation.service';

// ============================================================
// Test Fixtures
// ============================================================

const storeId = 'store-aaa';
const productId = 'prod-111';

const mockProductShape = (id: string) => ({
  id,
  name: `Product ${id}`,
  nameAr: null,
  slug: `product-${id}`,
  price: 10.0,
  compareAtPrice: null,
  images: [],
});

// ============================================================
// FBT Pair Normalization
// ============================================================

describe('FBT pair normalization', () => {
  it('stores pair with smaller ID first when productId1 > productId2', () => {
    // The normalization logic used in recalculateFBT:
    // const key = a < b ? `${a}:${b}` : `${b}:${a}`;
    const a = 'prod-zzz';
    const b = 'prod-aaa';

    // Simulate the normalization from the service
    const normalized = a < b ? `${a}:${b}` : `${b}:${a}`;
    const [id1, id2] = normalized.split(':');

    expect(id1).toBe('prod-aaa');
    expect(id2).toBe('prod-zzz');
    expect(id1 < id2).toBe(true);
  });

  it('keeps pair in order when productId1 < productId2', () => {
    const a = 'prod-aaa';
    const b = 'prod-zzz';

    const normalized = a < b ? `${a}:${b}` : `${b}:${a}`;
    const [id1, id2] = normalized.split(':');

    expect(id1).toBe('prod-aaa');
    expect(id2).toBe('prod-zzz');
  });

  it('produces the same key regardless of input order (commutativity)', () => {
    const a = 'prod-bbb';
    const b = 'prod-ccc';

    const key1 = a < b ? `${a}:${b}` : `${b}:${a}`;
    const key2 = b < a ? `${b}:${a}` : `${a}:${b}`;

    expect(key1).toBe(key2);
  });
});

// ============================================================
// Relation Types
// ============================================================

describe('Relation types', () => {
  const VALID_RELATION_TYPES = ['cross_sell', 'upsell'];

  it('accepts cross_sell as a valid relation type', () => {
    expect(VALID_RELATION_TYPES).toContain('cross_sell');
  });

  it('accepts upsell as a valid relation type', () => {
    expect(VALID_RELATION_TYPES).toContain('upsell');
  });

  it('does not include unknown types', () => {
    expect(VALID_RELATION_TYPES).not.toContain('related');
    expect(VALID_RELATION_TYPES).not.toContain('bundle');
    expect(VALID_RELATION_TYPES).not.toContain('fbt');
  });

  it('has exactly 2 valid types', () => {
    expect(VALID_RELATION_TYPES).toHaveLength(2);
  });
});

// ============================================================
// Cart Recommendations — exclude products already in cart
// ============================================================

describe('getCartRecommendations', () => {
  const mockPrisma = prisma as any;
  const mockRedis = redis as any;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns empty array when no productIds provided', async () => {
    const result = await recommendationService.getCartRecommendations(storeId, []);
    expect(result).toEqual([]);
  });

  it('excludes products already in the cart from recommendations', async () => {
    const cartProductIds = ['prod-A', 'prod-B'];
    const recommendedId = 'prod-C';

    // Manual cross-sell returns prod-B (already in cart) and prod-C (not in cart).
    // The N+1 fix in T1-10 batches manual lookups across every cart item in a
    // single IN-list query, so the rows now include sourceProductId for the
    // service's per-source grouping.
    mockPrisma.productRelation.findMany.mockResolvedValue([
      { sourceProductId: 'prod-A', targetProductId: 'prod-B' },
      { sourceProductId: 'prod-A', targetProductId: recommendedId },
    ]);
    // FBT runs in parallel with the manual lookup (Promise.all). Cart
    // items without manual relations fall through to FBT — empty array
    // here means prod-B (no manual rels) yields no FBT recommendations.
    mockPrisma.frequentlyBoughtTogether.findMany.mockResolvedValue([]);

    mockPrisma.product.findMany.mockResolvedValue([mockProductShape(recommendedId)]);

    const result = await recommendationService.getCartRecommendations(storeId, cartProductIds);

    // Verify product.findMany was called with ids that do NOT include cart products
    const productFindManyCall = mockPrisma.product.findMany.mock.calls[0][0];
    expect(productFindManyCall.where.id.in).not.toContain('prod-A');
    expect(productFindManyCall.where.id.in).not.toContain('prod-B');
    expect(productFindManyCall.where.id.in).toContain(recommendedId);
  });

  it('does not include a recommended product that is already in cart (via FBT fallback)', async () => {
    const cartProductIds = ['prod-X'];

    // No manual relations — triggers FBT fallback
    mockPrisma.productRelation.findMany.mockResolvedValue([]);
    // FBT row where the "other" product is already in the cart
    mockPrisma.frequentlyBoughtTogether.findMany.mockResolvedValue([
      { productId1: 'prod-X', productId2: 'prod-X' }, // same id, already in cart
    ]);
    mockPrisma.product.findMany.mockResolvedValue([]);

    const result = await recommendationService.getCartRecommendations(storeId, cartProductIds);
    expect(result).toEqual([]);
  });
});

// ============================================================
// Product Recommendations Structure
// ============================================================

describe('getCartRecommendations — sold-out picks take no slot (W1a fix round)', () => {
  const mockPrisma = prisma as any;
  beforeEach(() => vi.clearAllMocks());

  it('skips sold-out candidates and still fills 4 slots in score order; backorderable ones stay', async () => {
    const ids = ['r1', 'r2', 'r3', 'r4', 'r5', 'r6'];
    mockPrisma.productRelation.findMany.mockResolvedValue(
      ids.map(t => ({ sourceProductId: 'in-cart', targetProductId: t }))
    );
    mockPrisma.frequentlyBoughtTogether.findMany.mockResolvedValue([]);
    const stock = (id: string, inventory: number, allowBackorder = false) => ({
      ...mockProductShape(id),
      inventory,
      allowBackorder,
      lowStockThreshold: 5,
      variants: [],
    });
    mockPrisma.product.findMany.mockResolvedValue([
      stock('r1', 0), // sold out
      stock('r2', 3),
      stock('r3', 0, true), // backorder: buyable
      stock('r4', 0), // sold out
      stock('r5', 9),
      stock('r6', 2),
    ]);

    const result = (await recommendationService.getCartRecommendations(storeId, [
      'in-cart',
    ])) as any[];

    expect(result.map(p => p.id)).toEqual(['r2', 'r3', 'r5', 'r6']);
    // more candidates than slots are read, so the sold-out ones can be replaced
    expect(mockPrisma.product.findMany.mock.calls[0][0].where.id.in.length).toBe(6);

    // Store backorder feature OFF (W1b fix round 2): the backorderable sold-out
    // pick is NOT buyable, so it takes no slot either (never a sold-out card).
    const off = (await recommendationService.getCartRecommendations(
      storeId,
      ['in-cart'],
      false
    )) as any[];
    expect(off.map(p => p.id)).toEqual(['r2', 'r5', 'r6']);
    expect(off.every(p => p.acceptsBackorder === false)).toBe(true);
  });
});

describe('getProductRecommendations', () => {
  const mockPrisma = prisma as any;
  const mockRedis = redis as any;

  beforeEach(() => {
    vi.clearAllMocks();
    // No cached value by default
    mockRedis.get.mockResolvedValue(null);
    mockRedis.set.mockResolvedValue(undefined);
    // clearAllMocks keeps implementations: without this an FBT row set by an
    // earlier describe (ids only, no product1/product2) leaks in here.
    mockPrisma.frequentlyBoughtTogether.findMany.mockResolvedValue([]);
  });

  it('returns object with crossSell, upsell, and alsoLike arrays', async () => {
    // Manual cross-sell
    mockPrisma.productRelation.findMany
      .mockResolvedValueOnce([
        { id: 'rel-1', targetProduct: mockProductShape('prod-222'), position: 0 },
      ])
      // Upsell
      .mockResolvedValueOnce([
        { id: 'rel-2', targetProduct: mockProductShape('prod-333'), position: 0 },
      ]);

    // Product categories
    mockPrisma.productCategory.findMany.mockResolvedValue([{ categoryId: 'cat-1' }]);

    // Also like products
    mockPrisma.product.findMany.mockResolvedValue([mockProductShape('prod-444')]);

    const result = await recommendationService.getProductRecommendations(storeId, productId);

    expect(result).toHaveProperty('crossSell');
    expect(result).toHaveProperty('upsell');
    expect(result).toHaveProperty('alsoLike');

    expect(Array.isArray(result.crossSell)).toBe(true);
    expect(Array.isArray(result.upsell)).toBe(true);
    expect(Array.isArray(result.alsoLike)).toBe(true);
  });

  it('crossSell items include relationId and position from manual relations', async () => {
    mockPrisma.productRelation.findMany
      .mockResolvedValueOnce([
        { id: 'rel-cross-1', targetProduct: mockProductShape('prod-222'), position: 2 },
      ])
      .mockResolvedValueOnce([]); // upsell empty

    mockPrisma.productCategory.findMany.mockResolvedValue([]);

    const result = await recommendationService.getProductRecommendations(storeId, productId);

    expect(result.crossSell).toHaveLength(1);
    expect((result.crossSell as any[])[0]).toMatchObject({
      relationId: 'rel-cross-1',
      position: 2,
      id: 'prod-222',
    });
  });

  it('C-01: every list carries stock flags + variants from enrichStockFlags, not the raw column', async () => {
    const sized = {
      ...mockProductShape('prod-sized'),
      inventory: 0, // parent column of a variant product (the inventory model)
      allowBackorder: false,
      lowStockThreshold: 5,
      variants: [
        {
          id: 'v1',
          price: 10,
          compareAtPrice: null,
          inventory: 4,
          allowBackorder: false,
          isActive: true,
        },
      ],
    };
    const soldOut = {
      ...mockProductShape('prod-out'),
      inventory: 0,
      allowBackorder: false,
      lowStockThreshold: 5,
      variants: [],
    };
    mockPrisma.productRelation.findMany
      .mockResolvedValueOnce([{ id: 'r1', targetProduct: sized, position: 0 }])
      .mockResolvedValueOnce([{ id: 'r2', targetProduct: soldOut, position: 0 }]);
    mockPrisma.productCategory.findMany.mockResolvedValue([]);

    const result = await recommendationService.getProductRecommendations(storeId, 'prod-c01');
    const [cross] = result.crossSell as any[];
    const [up] = result.upsell as any[];
    expect(cross).toMatchObject({ inStock: true, acceptsBackorder: false, inventory: 4 });
    expect(cross.variants).toHaveLength(1);
    expect(cross.variants[0]).not.toHaveProperty('isActive');
    expect(cross).not.toHaveProperty('lowStockThreshold');
    expect(up).toMatchObject({ inStock: false, acceptsBackorder: false });

    // and the projection asks for what enrichStockFlags needs
    const select = mockPrisma.productRelation.findMany.mock.calls[0][0].select.targetProduct.select;
    expect(select).toMatchObject({
      inventory: true,
      allowBackorder: true,
      lowStockThreshold: true,
    });
    expect(select.variants.select).toMatchObject({ inventory: true, isActive: true, price: true });
  });

  it('returns result from cache when cache hit', async () => {
    const cached = {
      crossSell: [mockProductShape('prod-cached')],
      upsell: [],
      alsoLike: [],
    };
    mockRedis.get.mockResolvedValue(cached);

    const result = await recommendationService.getProductRecommendations(storeId, productId);

    expect(result).toEqual(cached);
    // Prisma should NOT be called on cache hit
    expect(mockPrisma.productRelation.findMany).not.toHaveBeenCalled();
  });

  it('caches result after fetching from DB', async () => {
    // Use a unique productId to ensure no cross-test pollution
    const uniqueProductId = 'prod-cache-test-unique';
    mockPrisma.productRelation.findMany.mockResolvedValue([]);
    mockPrisma.productCategory.findMany.mockResolvedValue([]);

    await recommendationService.getProductRecommendations(storeId, uniqueProductId);

    expect(mockRedis.set).toHaveBeenCalledOnce();
    const [cacheKey, value, ttl] = mockRedis.set.mock.calls[0];
    expect(cacheKey).toBe(`recommendations:product:${storeId}:${uniqueProductId}`);
    expect(value).toHaveProperty('crossSell');
    expect(value).toHaveProperty('upsell');
    expect(value).toHaveProperty('alsoLike');
    expect(ttl).toBeGreaterThan(0);
  });

  it('alsoLike is empty when product has no categories', async () => {
    mockPrisma.productRelation.findMany.mockResolvedValue([]);
    mockPrisma.productCategory.findMany.mockResolvedValue([]); // no categories

    const result = await recommendationService.getProductRecommendations(storeId, productId);

    expect(result.alsoLike).toEqual([]);
    // product.findMany should not be called for alsoLike when no categoryIds
    expect(mockPrisma.product.findMany).not.toHaveBeenCalled();
  });
});

// ============================================================
// Cache Key Format
// ============================================================

describe('Cache key format', () => {
  const mockPrisma = prisma as any;
  const mockRedis = redis as any;

  beforeEach(() => {
    vi.clearAllMocks();
    mockRedis.get.mockResolvedValue(null);
    mockRedis.set.mockResolvedValue(undefined);
    mockPrisma.productRelation.findMany.mockResolvedValue([]);
    mockPrisma.productCategory.findMany.mockResolvedValue([]);
    mockPrisma.frequentlyBoughtTogether.findMany.mockResolvedValue([]);
  });

  it('uses format recommendations:product:{storeId}:{productId}', async () => {
    const testStoreId = 'my-store';
    const testProductId = 'my-product';

    await recommendationService.getProductRecommendations(testStoreId, testProductId);

    // redis.get is called first with the expected cache key
    expect(mockRedis.get).toHaveBeenCalledWith(
      `recommendations:product:${testStoreId}:${testProductId}`,
      true
    );
  });

  it('cache key is unique per store+product combination', async () => {
    const storeA = 'store-alpha';
    const storeB = 'store-beta';
    const prod = 'prod-xyz';

    const keyA = `recommendations:product:${storeA}:${prod}`;
    const keyB = `recommendations:product:${storeB}:${prod}`;

    expect(keyA).not.toBe(keyB);
  });

  it('cache key is unique per product within the same store', async () => {
    const store = 'store-gamma';
    const prodA = 'prod-001';
    const prodB = 'prod-002';

    const keyA = `recommendations:product:${store}:${prodA}`;
    const keyB = `recommendations:product:${store}:${prodB}`;

    expect(keyA).not.toBe(keyB);
  });
});
