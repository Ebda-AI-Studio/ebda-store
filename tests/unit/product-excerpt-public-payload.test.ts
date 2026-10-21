/**
 * Product Service — public payload excerpt exposure.
 *
 * The `bulk-ai-excerpt` sweep writes `Product.excerpt` / `excerptAr`, but
 * until this test was added nothing verified that the public storefront
 * payload (`getPublicBySlug` / `getPublicById`) actually carries those
 * fields through. Both queries use Prisma `include` (not `select`), so
 * every scalar column — including `excerpt`/`excerptAr` — flows through the
 * `...product` spread in `reshapePublicProductDetail` automatically. This
 * test guards that behavior against a future refactor to an explicit
 * `select` that could silently drop the fields again.
 *
 * No DB required — prisma + all service-level side-effect modules are
 * mocked (mirrors the pattern in tests/unit/recommendation.test.ts).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { findFirstMock, reviewAggregateMock } = vi.hoisted(() => ({
  findFirstMock: vi.fn(),
  reviewAggregateMock: vi.fn().mockResolvedValue({ _avg: { rating: null }, _count: { rating: 0 } }),
}));

vi.mock('@ebda/database', () => ({
  prisma: {
    product: {
      findFirst: findFirstMock,
    },
    review: {
      aggregate: reviewAggregateMock,
    },
  },
  Prisma: {},
  ProductStatus: {},
  OrderStatus: {},
  withMoneyTx: vi.fn(async (_prisma: unknown, cb: (tx: unknown) => unknown) => cb({})),
}));

vi.mock('../../apps/api/src/services/feature.service', () => ({
  featureService: { isFeatureEnabled: vi.fn().mockResolvedValue(false) },
}));

vi.mock('../../apps/api/src/services/redis.service', () => ({
  redis: {
    get: vi.fn(),
    set: vi.fn(),
    delete: vi.fn(),
  },
}));

vi.mock('../../apps/api/src/lib/public-cache', () => ({
  invalidateCached: vi.fn(),
  invalidateCachedPrefix: vi.fn(),
  getCached: vi.fn(),
  setEdgeCache: vi.fn(),
}));

vi.mock('../../apps/api/src/lib/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../../apps/api/src/services/r2-cleanup.service', () => ({
  cleanupRemovedImages: vi.fn(),
}));

vi.mock('../../apps/api/src/lib/inngest/client', () => ({
  inngest: { send: vi.fn() },
}));

vi.mock('../../apps/api/src/services/ai-autofill.service', () => ({
  stampHumanEdits: vi.fn(() => ({})),
}));

// eslint-disable-next-line import/first
import { ProductService } from '../../apps/api/src/services/product.service';

describe('ProductService — public payload carries excerpt/excerptAr', () => {
  beforeEach(() => {
    findFirstMock.mockReset();
    reviewAggregateMock.mockClear();
  });

  const baseProduct = {
    id: 'prod-1',
    storeId: 'store-1',
    slug: 'olive-oil',
    name: 'Olive Oil',
    nameAr: 'زيت زيتون',
    price: 5000,
    inventory: 10,
    lowStockThreshold: 5,
    allowBackorder: false,
    excerpt: 'Cold-pressed extra virgin olive oil, bottled fresh.',
    excerptAr: 'زيت زيتون بكر ممتاز معصور على البارد.',
    options: [],
    variants: [],
    images: [{ id: 'img-1', url: 'https://example.com/a.jpg', alt: 'Olive Oil bottle' }],
  };

  it('getPublicBySlug returns excerpt + excerptAr on the response', async () => {
    findFirstMock.mockResolvedValue(baseProduct);

    const result = await ProductService.getPublicBySlug('store-1', 'olive-oil');

    expect(result.excerpt).toBe(baseProduct.excerpt);
    expect(result.excerptAr).toBe(baseProduct.excerptAr);
  });

  it('getPublicById returns excerpt + excerptAr on the response', async () => {
    findFirstMock.mockResolvedValue(baseProduct);

    const result = await ProductService.getPublicById('store-1', 'prod-1');

    expect(result.excerpt).toBe(baseProduct.excerpt);
    expect(result.excerptAr).toBe(baseProduct.excerptAr);
  });

  it('passes through a null excerpt (product never swept) without throwing', async () => {
    findFirstMock.mockResolvedValue({ ...baseProduct, excerpt: null, excerptAr: null });

    const result = await ProductService.getPublicBySlug('store-1', 'olive-oil');

    expect(result.excerpt).toBeNull();
    expect(result.excerptAr).toBeNull();
  });
});
