import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock inngest client before importing the function
vi.mock('@api/lib/inngest/client', () => ({
  inngest: {
    createFunction: vi.fn((config: any, trigger: any, fn: any) => {
      return { id: config.id, fn };
    }),
  },
}));

// Mock the feature gate so the function doesn't try to read prisma at
// module init. Default: whatsapp feature ENABLED so existing skip-paths
// (no catalog id, no wbs base url) are still exercised. Individual tests
// can override per-test if they want to verify the feature-disabled path.
vi.mock('@api/services/feature.service', () => ({
  featureService: {
    isFeatureEnabled: vi.fn().mockResolvedValue(true),
  },
}));

// product-meta-sync wraps its DB reads in runInTenantContext (the real one
// validates the storeId is a UUID). These tests inject a mock prisma and use a
// short non-UUID test storeId, so mock the tenant context to a passthrough that
// just runs the callback (prisma comes from the injected mock below).
vi.mock('@ebda/database', () => ({
  prisma: {},
  runInTenantContext: (_storeId: string, fn: () => unknown) => fn(),
}));

import { productMetaSync } from '@api/lib/inngest/functions/product-meta-sync';
import { featureService } from '@api/services/feature.service';

describe('productMetaSync', () => {
  beforeEach(() => {
    process.env.EBDA_WA_BASE_URL = 'http://wbs:3001';
    delete process.env.WBS_RECEIVER_BASE_URL;
    vi.clearAllMocks();
    // Reset global fetch mock
    vi.stubGlobal('fetch', undefined);
  });

  it('skips when store has no meta_catalog_id', async () => {
    const event = { data: { storeId: 'store1', productId: 'prod1', action: 'upsert' as const } };
    const step = {
      run: vi.fn((name: string, fn: () => any) => fn()),
    };
    const mockPrisma = {
      store: { findUnique: vi.fn().mockResolvedValue({ metaCatalogId: null, settings: {} }) },
      product: { findUnique: vi.fn() },
    };
    const result = await productMetaSync({ event, step, prisma: mockPrisma as any });
    expect(result.skipped).toBe(true);
    expect(mockPrisma.product.findUnique).not.toHaveBeenCalled();
  });

  it('skips when no EBDA_WA_BASE_URL is configured', async () => {
    const event = { data: { storeId: 'store1', productId: 'prod1', action: 'upsert' as const } };
    const step = { run: vi.fn((name: string, fn: () => any) => fn()) };
    const mockPrisma = {
      store: {
        findUnique: vi.fn().mockResolvedValue({
          metaCatalogId: 'cat123',
          settings: {}, // no wbsBaseUrl
        }),
      },
      product: { findUnique: vi.fn() },
    };
    // No WBS_RECEIVER_BASE_URL env
    delete process.env.EBDA_WA_BASE_URL;
    delete process.env.WBS_RECEIVER_BASE_URL;
    const result = await productMetaSync({ event, step, prisma: mockPrisma as any });
    expect(result.skipped).toBe(true);
    expect(result.reason).toBe('no-wbs-url');
  });

  it('NEVER posts the receiver secret to a store-supplied URL (settings.wbsBaseUrl is ignored)', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({}) });
    vi.stubGlobal('fetch', fetchMock);
    const event = { data: { storeId: 'store1', productId: 'prod1', action: 'delete' as const } };
    const step = { run: vi.fn((name: string, fn: () => any) => fn()) };
    const mockPrisma = {
      store: {
        findUnique: vi.fn().mockResolvedValue({
          metaCatalogId: 'cat123',
          settings: { wbsBaseUrl: 'https://evil.test' },
        }),
      },
      product: { findUnique: vi.fn() },
    };
    await productMetaSync({ event, step, prisma: mockPrisma as any });
    const urls = fetchMock.mock.calls.map(c => String(c[0]));
    expect(urls.length).toBeGreaterThan(0);
    expect(urls.every(u => u.startsWith('http://wbs:3001'))).toBe(true);
  });

  it('calls WBS receiver when store has meta_catalog_id + the platform receiver URL', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal('fetch', fetchMock);

    const event = { data: { storeId: 'store1', productId: 'prod1', action: 'upsert' as const } };
    const step = { run: vi.fn((name: string, fn: () => any) => fn()) };
    const mockPrisma = {
      store: {
        findUnique: vi.fn().mockResolvedValue({
          metaCatalogId: 'cat123',
          settings: {},
          name: 'Demo Shop',
          slug: 'demo-shop',
          domain: 'demo-shop.example',
          currency: 'EGP',
        }),
      },
      product: {
        findUnique: vi.fn().mockResolvedValue({
          id: 'prod1',
          name: 'Test Product',
          nameAr: null,
          slug: 'test-product',
          price: 1000,
          description: null,
          images: [{ url: 'https://img/p.jpg' }],
          status: 'active',
        }),
      },
    };

    const result = await productMetaSync({ event, step, prisma: mockPrisma as any });
    expect(result.skipped).toBe(false);
    expect(fetchMock).toHaveBeenCalledWith(
      'http://wbs:3001/api/v1/external/internal/inngest-receiver',
      expect.objectContaining({
        method: 'POST',
        body: expect.stringContaining('"action":"upsert"'),
      })
    );
    // payload enriched with the Meta feed fields WBS can't derive
    const sent = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(sent.product).toMatchObject({
      link: 'https://demo-shop.example/products/test-product',
      brand: 'Demo Shop',
      currency: 'EGP',
    });
  });

  it('calls WBS receiver for delete action without fetching product', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal('fetch', fetchMock);

    const event = { data: { storeId: 'store1', productId: 'prod1', action: 'delete' as const } };
    const step = { run: vi.fn((name: string, fn: () => any) => fn()) };
    const mockPrisma = {
      store: {
        findUnique: vi.fn().mockResolvedValue({
          metaCatalogId: 'cat123',
          settings: {},
        }),
      },
      product: { findUnique: vi.fn() },
    };

    await productMetaSync({ event, step, prisma: mockPrisma as any });
    // Product should NOT be fetched for delete
    expect(mockPrisma.product.findUnique).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledWith(
      'http://wbs:3001/api/v1/external/internal/inngest-receiver',
      expect.objectContaining({
        body: expect.stringContaining('"action":"delete"'),
      })
    );
  });

  // ── Error handling tests ───────────────────────────────────────────────────

  it('skips gracefully (no throw) when WBS returns 400 (store not connected)', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      json: vi.fn().mockResolvedValue({ error: 'CLIENT_NOT_CONFIGURED' }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const event = { data: { storeId: 'store1', productId: 'prod1', action: 'upsert' as const } };
    const step = { run: vi.fn((name: string, fn: () => any) => fn()) };
    const mockPrisma = {
      store: {
        findUnique: vi.fn().mockResolvedValue({
          metaCatalogId: 'cat123',
          settings: {},
          name: 'Demo Boutique',
          slug: 'demo-boutique',
          domain: null,
          currency: 'EGP',
        }),
      },
      product: {
        findUnique: vi.fn().mockResolvedValue({
          id: 'prod1',
          name: 'P',
          nameAr: null,
          slug: 'p',
          price: 100,
          description: null,
          images: [],
          status: 'active',
        }),
      },
    };

    const result = await productMetaSync({ event, step, prisma: mockPrisma as any });
    expect(result.skipped).toBe(true);
    expect(result.reason).toBe('wbs-not-connected');
    expect(result.status).toBe(400);
  });

  it('skips gracefully when WBS returns 400 with unparseable body', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      json: vi.fn().mockRejectedValue(new Error('not json')),
    });
    vi.stubGlobal('fetch', fetchMock);

    const event = { data: { storeId: 'store1', productId: 'prod1', action: 'upsert' as const } };
    const step = { run: vi.fn((name: string, fn: () => any) => fn()) };
    const mockPrisma = {
      store: {
        findUnique: vi.fn().mockResolvedValue({
          metaCatalogId: 'cat123',
          settings: {},
          name: 'Demo Boutique',
          slug: 'demo-boutique',
          domain: null,
          currency: 'EGP',
        }),
      },
      product: {
        findUnique: vi.fn().mockResolvedValue({
          id: 'prod1',
          name: 'P',
          nameAr: null,
          slug: 'p',
          price: 100,
          description: null,
          images: [],
          status: 'active',
        }),
      },
    };

    const result = await productMetaSync({ event, step, prisma: mockPrisma as any });
    expect(result.skipped).toBe(true);
    expect(result.reason).toBe('wbs-not-connected');
  });

  it('throws (retryable) when WBS returns 401 (auth misconfiguration)', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      json: vi.fn().mockResolvedValue({ error: 'unauthorized' }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const event = { data: { storeId: 'store1', productId: 'prod1', action: 'upsert' as const } };
    const step = { run: vi.fn((name: string, fn: () => any) => fn()) };
    const mockPrisma = {
      store: {
        findUnique: vi.fn().mockResolvedValue({
          metaCatalogId: 'cat123',
          settings: {},
          name: 'Demo Boutique',
          slug: 'demo-boutique',
          domain: null,
          currency: 'EGP',
        }),
      },
      product: {
        findUnique: vi.fn().mockResolvedValue({
          id: 'prod1',
          name: 'P',
          nameAr: null,
          slug: 'p',
          price: 100,
          description: null,
          images: [],
          status: 'active',
        }),
      },
    };

    await expect(productMetaSync({ event, step, prisma: mockPrisma as any })).rejects.toThrow(
      'wbs receiver returned 401'
    );
  });

  it('throws (retryable) when WBS returns 500 (server error)', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      json: vi.fn().mockResolvedValue({ error: 'internal server error' }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const event = { data: { storeId: 'store1', productId: 'prod1', action: 'upsert' as const } };
    const step = { run: vi.fn((name: string, fn: () => any) => fn()) };
    const mockPrisma = {
      store: {
        findUnique: vi.fn().mockResolvedValue({
          metaCatalogId: 'cat123',
          settings: {},
          name: 'Demo Boutique',
          slug: 'demo-boutique',
          domain: null,
          currency: 'EGP',
        }),
      },
      product: {
        findUnique: vi.fn().mockResolvedValue({
          id: 'prod1',
          name: 'P',
          nameAr: null,
          slug: 'p',
          price: 100,
          description: null,
          images: [],
          status: 'active',
        }),
      },
    };

    await expect(productMetaSync({ event, step, prisma: mockPrisma as any })).rejects.toThrow(
      'wbs receiver returned 500'
    );
  });
});
