import { describe, it, expect, vi, beforeEach } from 'vitest';

// --- Mocks -----------------------------------------------------------------
// `listPublic`'s only caller (`GET /public/products`) already wraps the whole
// call in `getCached()` under a `public:products:<storeId>:...` key that IS
// correctly swept by `invalidateStoreProductCaches`. Before the H1 fix,
// `listPublic` ALSO ran its own raw `redis.get`/`redis.set` under a different,
// never-invalidated key (`products:store:<storeId>:...`), so a stale value
// left there would resurrect itself on the very next outer-cache miss and get
// written straight back into the freshly-busted outer cache. This test seeds
// exactly that stale value and asserts it is never served.

const { mockRedisGet, mockRedisSet } = vi.hoisted(() => ({
  mockRedisGet: vi.fn(),
  mockRedisSet: vi.fn(),
}));

vi.mock('../redis.service', () => ({
  redis: {
    get: mockRedisGet,
    set: mockRedisSet,
    delete: vi.fn(),
    deleteByPattern: vi.fn(),
  },
}));

const {
  mockProductFindMany,
  mockProductCount,
  mockProductOptionFindMany,
  mockCategoryFindFirst,
  mockProductCategoryFindMany,
} = vi.hoisted(() => ({
  mockProductFindMany: vi.fn(),
  mockProductCount: vi.fn(),
  mockProductOptionFindMany: vi.fn(),
  mockCategoryFindFirst: vi.fn(),
  mockProductCategoryFindMany: vi.fn(),
}));

vi.mock('@ebda/database', () => ({
  prisma: {
    product: { findMany: mockProductFindMany, count: mockProductCount },
    productOption: { findMany: mockProductOptionFindMany },
    category: { findFirst: mockCategoryFindFirst },
    productCategory: { findMany: mockProductCategoryFindMany },
  },
  Prisma: {},
  ProductStatus: {},
  OrderStatus: {},
  withMoneyTx: vi.fn(),
}));

vi.mock('../r2-cleanup.service', () => ({ cleanupRemovedImages: vi.fn() }));
vi.mock('../ai-autofill.service', () => ({ stampHumanEdits: vi.fn() }));
vi.mock('../../lib/inngest/client', () => ({ inngest: { send: vi.fn() } }));

import { ProductService } from '../product.service';

describe('ProductService.listPublic — H1 cache-stampede-audit regression (docs/audits/2026-07-13-cache-stampede.md)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('serves fresh DB data, never a stale value from the removed inner `products:store:*` cache — even when one is seeded in Redis', async () => {
    const storeId = 'store-1';

    // Simulate exactly what the pre-fix bug left behind: a stale payload
    // sitting under the inner cache key that `invalidateStoreProductCaches`
    // never swept. Under the OLD code this alone would make `listPublic`
    // return the stale payload without ever touching prisma.
    mockRedisGet.mockResolvedValue(
      JSON.stringify({
        products: [{ id: 'stale-pre-invalidation', price: 99900 }],
        facets: [],
        meta: { total: 1 },
      })
    );

    const freshProduct = {
      id: 'fresh-post-invalidation',
      price: 11100,
      inventory: 5,
      allowBackorder: false,
      lowStockThreshold: 0,
      variants: [],
    };
    mockProductFindMany.mockResolvedValue([freshProduct]);
    mockProductCount.mockResolvedValue(1);
    mockProductOptionFindMany.mockResolvedValue([]);

    const result = await ProductService.listPublic(storeId, {});

    // Must be the fresh DB row a merchant's price/stock edit would produce —
    // never the stale redis payload from the dead inner cache.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(result.products.map((p: any) => p.id)).toEqual(['fresh-post-invalidation']);
    expect(mockProductFindMany).toHaveBeenCalledTimes(1);
    expect(mockProductCount).toHaveBeenCalledTimes(1);

    // The inner cache layer is removed entirely (not just re-pointed at a
    // swept prefix) — listPublic must not touch redis.get/set at all now
    // that the route's outer getCached() wrapper is the only cache.
    expect(mockRedisGet).not.toHaveBeenCalled();
    expect(mockRedisSet).not.toHaveBeenCalled();
  });

  it('two calls with different results (simulating an edit between them) both hit the DB fresh — no cross-call resurrection', async () => {
    const storeId = 'store-2';
    mockRedisGet.mockResolvedValue(null);
    mockProductOptionFindMany.mockResolvedValue([]);

    mockProductFindMany.mockResolvedValueOnce([
      {
        id: 'p1',
        price: 1000,
        inventory: 5,
        allowBackorder: false,
        lowStockThreshold: 0,
        variants: [],
      },
    ]);
    mockProductCount.mockResolvedValueOnce(1);
    const before = await ProductService.listPublic(storeId, {});
    expect(before.products[0].price).toBe(1000);

    // Merchant edits the price; a real caller would invalidate the OUTER
    // `public:products:*` cache here (route-level getCached), which is out
    // of scope for this unit test — the point is that `listPublic` itself
    // has no memory between calls that could defeat that invalidation.
    mockProductFindMany.mockResolvedValueOnce([
      {
        id: 'p1',
        price: 500,
        inventory: 5,
        allowBackorder: false,
        lowStockThreshold: 0,
        variants: [],
      },
    ]);
    mockProductCount.mockResolvedValueOnce(1);
    const after = await ProductService.listPublic(storeId, {});
    expect(after.products[0].price).toBe(500);

    expect(mockProductFindMany).toHaveBeenCalledTimes(2);
  });
});
