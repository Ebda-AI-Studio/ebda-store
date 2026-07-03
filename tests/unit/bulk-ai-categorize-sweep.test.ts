/**
 * bulk-ai-categorize Inngest function — Unit Tests
 *
 * Covers:
 *  - only queries uncategorized products (categories: { none: {} })
 *  - assigns the top match returned by the generator
 *  - skips (does not fail) when the generator returns no confident match
 *  - skips every product cleanly when the store has zero categories
 *    (never calls Gemini)
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../apps/api/src/lib/logger', () => ({
  default: { warn: vi.fn(), debug: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

vi.mock('../../apps/api/src/config', () => ({
  config: { googleAiKey: 'fake-key' },
}));

const mockAssertAiQuota = vi.fn().mockResolvedValue(undefined);
vi.mock('../../apps/api/src/lib/ai-quota', () => ({
  assertAiQuota: (...args: unknown[]) => mockAssertAiQuota(...args),
  isAiQuotaCapError: () => false,
}));

vi.mock('../../apps/api/src/lib/inngest/ai-retry', () => ({
  callWithRetry: (fn: () => unknown) => fn(),
}));

const mockSuggestProductCategory = vi.fn();
vi.mock('../../apps/api/src/lib/ai/product-category-suggester', () => ({
  suggestProductCategory: (...args: unknown[]) => mockSuggestProductCategory(...args),
}));

const mockFindUniqueStore = vi.fn();
const mockFindManyCategory = vi.fn();
const mockFindManyProduct = vi.fn();
const mockCreateProductCategory = vi.fn();
const mockFindUniqueJob = vi.fn();
const mockUpdateJob = vi.fn();

vi.mock('@force/database', () => ({
  prisma: {
    store: { findUnique: (...args: unknown[]) => mockFindUniqueStore(...args) },
    category: { findMany: (...args: unknown[]) => mockFindManyCategory(...args) },
    product: { findMany: (...args: unknown[]) => mockFindManyProduct(...args) },
    productCategory: { create: (...args: unknown[]) => mockCreateProductCategory(...args) },
    bulkAiJob: {
      findUnique: (...args: unknown[]) => mockFindUniqueJob(...args),
      update: (...args: unknown[]) => mockUpdateJob(...args),
    },
  },
}));

let capturedHandler: (args: { event: { data: unknown } }) => Promise<void>;
vi.mock('../../apps/api/src/lib/inngest/client', () => ({
  inngest: {
    createFunction: (_cfg: unknown, handler: typeof capturedHandler) => {
      capturedHandler = handler;
      return { id: 'bulk-ai-categorize' };
    },
  },
}));

beforeEach(async () => {
  vi.resetModules();
  process.env.AI_BULK_THROTTLE_MS = '0';
  mockAssertAiQuota.mockClear();
  mockSuggestProductCategory.mockReset();
  mockFindUniqueStore.mockReset();
  mockFindManyCategory.mockReset();
  mockFindManyProduct.mockReset();
  mockCreateProductCategory.mockReset();
  mockFindUniqueJob.mockReset();
  mockUpdateJob.mockReset();

  mockFindUniqueStore.mockResolvedValue({ name: 'Test Store' });
  mockFindUniqueJob.mockResolvedValue({ status: 'running' });
  mockUpdateJob.mockResolvedValue({});

  await import('../../apps/api/src/lib/inngest/functions/bulk-ai-categorize.js');
});

async function runSweep(data: { jobId: string; storeId: string; force?: boolean }) {
  await capturedHandler({ event: { data } });
}

describe('bulk-ai-categorize sweep', () => {
  it('queries only uncategorized products', async () => {
    mockFindManyCategory.mockResolvedValue([{ id: 'cat-1', name: 'Clothing', nameAr: null }]);
    mockFindManyProduct.mockResolvedValue([]);

    await runSweep({ jobId: 'job-1', storeId: 'store-1' });

    expect(mockFindManyProduct).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ categories: { none: {} } }),
      })
    );
  });

  it('assigns the top match returned by the generator', async () => {
    mockFindManyCategory.mockResolvedValue([{ id: 'cat-1', name: 'Clothing', nameAr: null }]);
    mockFindManyProduct.mockResolvedValue([
      { id: 'p1', name: 'Cotton Tee', description: 'A soft cotton tee' },
    ]);
    mockSuggestProductCategory.mockResolvedValue([{ id: 'cat-1', confidence: 'high' }]);

    await runSweep({ jobId: 'job-1', storeId: 'store-1' });

    expect(mockCreateProductCategory).toHaveBeenCalledWith({
      data: { productId: 'p1', categoryId: 'cat-1', position: 0 },
    });
    const finalCall = mockUpdateJob.mock.calls[mockUpdateJob.mock.calls.length - 1][0];
    expect(finalCall.data.filled).toBe(1);
  });

  it('skips (not fails) when the generator returns no confident match', async () => {
    mockFindManyCategory.mockResolvedValue([{ id: 'cat-1', name: 'Clothing', nameAr: null }]);
    mockFindManyProduct.mockResolvedValue([
      { id: 'p1', name: 'Mystery Item', description: 'unclear' },
    ]);
    mockSuggestProductCategory.mockResolvedValue([]);

    await runSweep({ jobId: 'job-1', storeId: 'store-1' });

    expect(mockCreateProductCategory).not.toHaveBeenCalled();
    const finalCall = mockUpdateJob.mock.calls[mockUpdateJob.mock.calls.length - 1][0];
    expect(finalCall.data.skipped).toBe(1);
    expect(finalCall.data.failed).toBe(0);
  });

  it('skips every product cleanly (no Gemini calls) when the store has zero categories', async () => {
    mockFindManyCategory.mockResolvedValue([]);
    mockFindManyProduct.mockResolvedValue([
      { id: 'p1', name: 'Product 1', description: 'desc' },
      { id: 'p2', name: 'Product 2', description: 'desc' },
    ]);

    await runSweep({ jobId: 'job-1', storeId: 'store-1' });

    expect(mockSuggestProductCategory).not.toHaveBeenCalled();
    const finalCall = mockUpdateJob.mock.calls[mockUpdateJob.mock.calls.length - 1][0];
    expect(finalCall.data.skipped).toBe(2);
  });
});
