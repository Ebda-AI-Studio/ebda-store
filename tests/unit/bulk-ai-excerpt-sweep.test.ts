/**
 * bulk-ai-excerpt Inngest function — Unit Tests
 *
 * Covers the provenance-aware skip/force logic:
 *  - skips a product that already has an excerpt (default, no force)
 *  - fills a product with no excerpt, stamping aiFieldSources 'ai'
 *  - force:true regenerates an ai-owned excerpt
 *  - force:true does NOT touch a human-owned excerpt (never clobbers)
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

// callWithRetry just calls the fn directly — retry behaviour isn't under test here.
vi.mock('../../apps/api/src/lib/inngest/ai-retry', () => ({
  callWithRetry: (fn: () => unknown) => fn(),
}));

const mockGenerateProductExcerpt = vi.fn();
vi.mock('../../apps/api/src/lib/ai/product-excerpt-generator', () => ({
  generateProductExcerpt: (...args: unknown[]) => mockGenerateProductExcerpt(...args),
}));

const mockFindUniqueStore = vi.fn();
const mockFindManyProduct = vi.fn();
const mockUpdateProduct = vi.fn();
// #620: the sweep writes through the one guarded fill-only layer, not product.update
const mockWriteBulk = vi.fn().mockResolvedValue(['excerpt']);
vi.mock('../../apps/api/src/services/ai-autofill.service', () => ({
  writeBulkProductFields: (...args: unknown[]) => mockWriteBulk(...args),
}));
const mockFindUniqueJob = vi.fn();
const mockUpdateJob = vi.fn();

vi.mock('@ebda/database', () => ({
  runInStoreScope: (_storeId: string, fn: () => unknown) => fn(),
  prisma: {
    store: { findUnique: (...args: unknown[]) => mockFindUniqueStore(...args) },
    product: {
      findMany: (...args: unknown[]) => mockFindManyProduct(...args),
      update: (...args: unknown[]) => mockUpdateProduct(...args),
    },
    bulkAiJob: {
      findUnique: (...args: unknown[]) => mockFindUniqueJob(...args),
      update: (...args: unknown[]) => mockUpdateJob(...args),
    },
  },
}));

// The Inngest function file imports `inngest` from '../client' to register
// itself via createFunction — stub createFunction to just capture + expose
// the handler so the test can invoke it directly without a running Inngest.
let capturedHandler: (args: {
  event: { data: unknown };
  step: { run: (id: string, fn: () => unknown) => Promise<unknown> };
}) => Promise<void>;
vi.mock('../../apps/api/src/lib/inngest/client', () => ({
  inngest: {
    createFunction: (_cfg: unknown, handler: typeof capturedHandler) => {
      capturedHandler = handler;
      return { id: 'bulk-ai-excerpt' };
    },
  },
}));

beforeEach(async () => {
  vi.resetModules();
  // Throttle reads process.env at module-load time — zero it so the sweep's
  // per-item sleep() doesn't slow down the test suite.
  process.env.AI_BULK_THROTTLE_MS = '0';
  mockAssertAiQuota.mockClear();
  mockGenerateProductExcerpt.mockReset();
  mockFindUniqueStore.mockReset();
  mockFindManyProduct.mockReset();
  mockUpdateProduct.mockReset();
  mockWriteBulk.mockClear();
  mockFindUniqueJob.mockReset();
  mockUpdateJob.mockReset();

  mockFindUniqueStore.mockResolvedValue({ name: 'Test Store' });
  mockFindUniqueJob.mockResolvedValue({ status: 'running' });
  mockUpdateJob.mockResolvedValue({});

  // Re-import so createFunction captures a fresh handler bound to this
  // test's reset mocks.
  await import('../../apps/api/src/lib/inngest/functions/bulk-ai-excerpt.js');
});

async function runSweep(data: { jobId: string; storeId: string; force?: boolean }) {
  const step = { run: (_id: string, fn: () => unknown) => Promise.resolve(fn()) };
  await capturedHandler({ event: { data }, step });
}

describe('bulk-ai-excerpt sweep', () => {
  it('skips a product that already has a human-owned excerpt (default, no force)', async () => {
    mockFindManyProduct.mockResolvedValue([
      {
        id: 'p1',
        name: 'Product 1',
        nameAr: null,
        description: 'desc',
        descriptionAr: null,
        excerpt: 'Already has an excerpt',
        excerptAr: null,
        aiFieldSources: {},
      },
    ]);

    await runSweep({ jobId: 'job-1', storeId: 'store-1' });

    expect(mockGenerateProductExcerpt).not.toHaveBeenCalled();
    const finalCall = mockUpdateJob.mock.calls[mockUpdateJob.mock.calls.length - 1][0];
    expect(finalCall.data.skipped).toBe(1);
    expect(finalCall.data.filled).toBe(0);
  });

  it('fills a product with no excerpt and stamps aiFieldSources as ai-owned', async () => {
    mockFindManyProduct.mockResolvedValue([
      {
        id: 'p1',
        name: 'Product 1',
        nameAr: null,
        description: 'A long description.',
        descriptionAr: null,
        excerpt: null,
        excerptAr: null,
        aiFieldSources: {},
      },
    ]);
    mockGenerateProductExcerpt.mockResolvedValue({
      excerpt: 'Short excerpt.',
      excerptAr: 'ملخص قصير.',
    });

    await runSweep({ jobId: 'job-1', storeId: 'store-1' });

    expect(mockWriteBulk).toHaveBeenCalledWith(
      'store-1',
      'p1',
      expect.objectContaining({ excerpt: null }),
      { excerpt: 'Short excerpt.', excerptAr: 'ملخص قصير.' },
      { overwrite: false }
    );
    const finalCall = mockUpdateJob.mock.calls[mockUpdateJob.mock.calls.length - 1][0];
    expect(finalCall.data.filled).toBe(1);
  });

  it('force:true regenerates an ai-owned excerpt', async () => {
    mockFindManyProduct.mockResolvedValue([
      {
        id: 'p1',
        name: 'Product 1',
        nameAr: null,
        description: 'desc',
        descriptionAr: null,
        excerpt: 'Old AI excerpt',
        excerptAr: null,
        aiFieldSources: { excerpt: 'ai' },
      },
    ]);
    mockGenerateProductExcerpt.mockResolvedValue({
      excerpt: 'Fresh excerpt.',
      excerptAr: 'ملخص جديد.',
    });

    await runSweep({ jobId: 'job-1', storeId: 'store-1', force: true });

    expect(mockGenerateProductExcerpt).toHaveBeenCalledTimes(1);
    expect(mockWriteBulk).toHaveBeenCalledWith(
      'store-1',
      'p1',
      expect.anything(),
      expect.objectContaining({ excerpt: 'Fresh excerpt.' }),
      { overwrite: true }
    );
  });

  it('force:true never touches a human-owned excerpt', async () => {
    mockFindManyProduct.mockResolvedValue([
      {
        id: 'p1',
        name: 'Product 1',
        nameAr: null,
        description: 'desc',
        descriptionAr: null,
        excerpt: 'Human-written excerpt',
        excerptAr: null,
        aiFieldSources: { excerpt: 'human' },
      },
    ]);

    await runSweep({ jobId: 'job-1', storeId: 'store-1', force: true });

    expect(mockGenerateProductExcerpt).not.toHaveBeenCalled();
    expect(mockUpdateProduct).not.toHaveBeenCalled();
  });
});
