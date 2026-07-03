/**
 * bulk-ai-tags Inngest function — Unit Tests
 *
 * Covers:
 *  - skips a product that already has >=1 tag (default, no force)
 *  - reuses an existing store Tag by case-insensitive name instead of
 *    creating a duplicate
 *  - creates a new Tag row only when no case-insensitive match exists
 *  - force:true tops up an already-tagged product without removing
 *    existing links, respecting the per-product cap
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

const mockSuggestProductTags = vi.fn();
vi.mock('../../apps/api/src/lib/ai/product-tag-suggester', () => ({
  suggestProductTags: (...args: unknown[]) => mockSuggestProductTags(...args),
  MAX_TAGS_PER_PRODUCT: 5,
}));

const mockFindUniqueStore = vi.fn();
const mockFindManyProduct = vi.fn();
const mockFindManyTag = vi.fn();
const mockCreateTag = vi.fn();
const mockCreateManyProductTag = vi.fn();
const mockFindUniqueJob = vi.fn();
const mockUpdateJob = vi.fn();

vi.mock('@force/database', () => ({
  prisma: {
    store: { findUnique: (...args: unknown[]) => mockFindUniqueStore(...args) },
    product: { findMany: (...args: unknown[]) => mockFindManyProduct(...args) },
    tag: {
      findMany: (...args: unknown[]) => mockFindManyTag(...args),
      create: (...args: unknown[]) => mockCreateTag(...args),
    },
    productTag: { createMany: (...args: unknown[]) => mockCreateManyProductTag(...args) },
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
      return { id: 'bulk-ai-tags' };
    },
  },
}));

beforeEach(async () => {
  vi.resetModules();
  process.env.AI_BULK_THROTTLE_MS = '0';
  mockAssertAiQuota.mockClear();
  mockSuggestProductTags.mockReset();
  mockFindUniqueStore.mockReset();
  mockFindManyProduct.mockReset();
  mockFindManyTag.mockReset();
  mockCreateTag.mockReset();
  mockCreateManyProductTag.mockReset();
  mockFindUniqueJob.mockReset();
  mockUpdateJob.mockReset();

  mockFindUniqueStore.mockResolvedValue({ name: 'Test Store' });
  mockFindUniqueJob.mockResolvedValue({ status: 'running' });
  mockUpdateJob.mockResolvedValue({});
  mockCreateManyProductTag.mockResolvedValue({ count: 1 });

  await import('../../apps/api/src/lib/inngest/functions/bulk-ai-tags.js');
});

async function runSweep(data: { jobId: string; storeId: string; force?: boolean }) {
  await capturedHandler({ event: { data } });
}

describe('bulk-ai-tags sweep', () => {
  it('skips a product that already has >=1 tag (default, no force)', async () => {
    mockFindManyTag.mockResolvedValue([]);
    mockFindManyProduct.mockResolvedValue([
      { id: 'p1', name: 'Product 1', description: 'desc', tags: [{ tagId: 'tag-existing' }] },
    ]);

    await runSweep({ jobId: 'job-1', storeId: 'store-1' });

    expect(mockSuggestProductTags).not.toHaveBeenCalled();
    const finalCall = mockUpdateJob.mock.calls[mockUpdateJob.mock.calls.length - 1][0];
    expect(finalCall.data.skipped).toBe(1);
  });

  it('reuses an existing tag by case-insensitive name instead of creating a duplicate', async () => {
    mockFindManyTag.mockResolvedValue([{ id: 'tag-cotton', name: 'Cotton' }]);
    mockFindManyProduct.mockResolvedValue([
      { id: 'p1', name: 'Product 1', description: 'cotton tee', tags: [] },
    ]);
    mockSuggestProductTags.mockResolvedValue(['cotton']); // different case than stored "Cotton"

    await runSweep({ jobId: 'job-1', storeId: 'store-1' });

    expect(mockCreateTag).not.toHaveBeenCalled();
    expect(mockCreateManyProductTag).toHaveBeenCalledWith(
      expect.objectContaining({
        data: [{ productId: 'p1', tagId: 'tag-cotton' }],
        skipDuplicates: true,
      })
    );
  });

  it('creates a new Tag row only when no case-insensitive match exists', async () => {
    mockFindManyTag.mockResolvedValue([]);
    mockFindManyProduct.mockResolvedValue([
      { id: 'p1', name: 'Product 1', description: 'a new kind of product', tags: [] },
    ]);
    mockSuggestProductTags.mockResolvedValue(['brand-new-tag']);
    mockCreateTag.mockResolvedValue({ id: 'tag-new', name: 'brand-new-tag' });

    await runSweep({ jobId: 'job-1', storeId: 'store-1' });

    expect(mockCreateTag).toHaveBeenCalledWith({
      data: { storeId: 'store-1', name: 'brand-new-tag' },
    });
    expect(mockCreateManyProductTag).toHaveBeenCalledWith(
      expect.objectContaining({ data: [{ productId: 'p1', tagId: 'tag-new' }] })
    );
  });

  it('force:true tops up an already-tagged product without removing existing tags', async () => {
    mockFindManyTag.mockResolvedValue([{ id: 'tag-summer', name: 'Summer' }]);
    mockFindManyProduct.mockResolvedValue([
      {
        id: 'p1',
        name: 'Product 1',
        description: 'desc',
        tags: [{ tagId: 'tag-existing' }], // already has 1 tag
      },
    ]);
    mockSuggestProductTags.mockResolvedValue(['summer']);

    await runSweep({ jobId: 'job-1', storeId: 'store-1', force: true });

    expect(mockSuggestProductTags).toHaveBeenCalledTimes(1);
    // Only the NEW tag is linked — the existing tag-existing link is untouched
    // (this sweep never deletes ProductTag rows).
    expect(mockCreateManyProductTag).toHaveBeenCalledWith(
      expect.objectContaining({ data: [{ productId: 'p1', tagId: 'tag-summer' }] })
    );
  });

  it('force:true skips a product already at the per-product tag cap', async () => {
    mockFindManyTag.mockResolvedValue([]);
    mockFindManyProduct.mockResolvedValue([
      {
        id: 'p1',
        name: 'Product 1',
        description: 'desc',
        tags: Array.from({ length: 5 }, (_, i) => ({ tagId: `tag-${i}` })), // already at cap
      },
    ]);

    await runSweep({ jobId: 'job-1', storeId: 'store-1', force: true });

    expect(mockSuggestProductTags).not.toHaveBeenCalled();
    const finalCall = mockUpdateJob.mock.calls[mockUpdateJob.mock.calls.length - 1][0];
    expect(finalCall.data.skipped).toBe(1);
  });
});
