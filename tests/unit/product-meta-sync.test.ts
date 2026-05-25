import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock inngest client before importing the function
vi.mock('@api/lib/inngest/client', () => ({
  inngest: {
    createFunction: vi.fn((config: any, trigger: any, fn: any) => {
      return { id: config.id, fn };
    }),
  },
}));

import { productMetaSync } from '@api/lib/inngest/functions/product-meta-sync';

describe('productMetaSync', () => {
  beforeEach(() => {
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

  it('skips when store has no wbsBaseUrl', async () => {
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
    delete process.env.WBS_RECEIVER_BASE_URL;
    const result = await productMetaSync({ event, step, prisma: mockPrisma as any });
    expect(result.skipped).toBe(true);
    expect(result.reason).toBe('no-wbs-url');
  });

  it('calls WBS receiver when store has meta_catalog_id + wbsBaseUrl', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal('fetch', fetchMock);

    const event = { data: { storeId: 'store1', productId: 'prod1', action: 'upsert' as const } };
    const step = { run: vi.fn((name: string, fn: () => any) => fn()) };
    const mockPrisma = {
      store: {
        findUnique: vi.fn().mockResolvedValue({
          metaCatalogId: 'cat123',
          settings: { wbsBaseUrl: 'http://wbs:3001' },
        }),
      },
      product: {
        findUnique: vi.fn().mockResolvedValue({
          id: 'prod1',
          name: 'Test Product',
          nameAr: null,
          price: 1000,
          currency: 'KWD',
          description: null,
          images: [],
          status: 'active',
        }),
      },
    };

    const result = await productMetaSync({ event, step, prisma: mockPrisma as any });
    expect(result.skipped).toBe(false);
    expect(fetchMock).toHaveBeenCalledWith(
      'http://wbs:3001/api/internal/inngest-receiver',
      expect.objectContaining({
        method: 'POST',
        body: expect.stringContaining('"action":"upsert"'),
      })
    );
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
          settings: { wbsBaseUrl: 'http://wbs:3001' },
        }),
      },
      product: { findUnique: vi.fn() },
    };

    await productMetaSync({ event, step, prisma: mockPrisma as any });
    // Product should NOT be fetched for delete
    expect(mockPrisma.product.findUnique).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledWith(
      'http://wbs:3001/api/internal/inngest-receiver',
      expect.objectContaining({
        body: expect.stringContaining('"action":"delete"'),
      })
    );
  });
});
