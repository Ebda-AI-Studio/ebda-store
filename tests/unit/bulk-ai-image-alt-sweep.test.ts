/**
 * bulk-ai-image-alt Inngest function — Unit Tests
 *
 * Covers:
 *  - skips a product entirely (no Gemini calls) when all its (capped)
 *    images already have alt text
 *  - writes alt text only for images missing it, leaving existing alt
 *    untouched
 *  - a product counts 'filled' if at least one image got a fresh alt
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

const mockReplaceText = vi.fn();
vi.mock('../../apps/api/src/services/catalogue-replace-backup.service', () => ({
  replaceTextWithBackup: (...args: unknown[]) => mockReplaceText(...args),
}));

const mockGenerateProductAltText = vi.fn();
vi.mock('../../apps/api/src/lib/ai/product-alt-text-generator', () => ({
  generateProductAltText: (...args: unknown[]) => mockGenerateProductAltText(...args),
}));

const mockFindManyProduct = vi.fn();
const mockUpdateProductImage = vi.fn();
const mockFindUniqueJob = vi.fn();
const mockUpdateJob = vi.fn();

vi.mock('@ebda/database', () => ({
  runInStoreScope: (_storeId: string, fn: () => unknown) => fn(),
  prisma: {
    product: { findMany: (...args: unknown[]) => mockFindManyProduct(...args) },
    productImage: { update: (...args: unknown[]) => mockUpdateProductImage(...args) },
    bulkAiJob: {
      findUnique: (...args: unknown[]) => mockFindUniqueJob(...args),
      update: (...args: unknown[]) => mockUpdateJob(...args),
    },
  },
}));

let capturedHandler: (args: {
  event: { data: unknown };
  step: { run: (id: string, fn: () => unknown) => Promise<unknown> };
}) => Promise<void>;
vi.mock('../../apps/api/src/lib/inngest/client', () => ({
  inngest: {
    createFunction: (_cfg: unknown, handler: typeof capturedHandler) => {
      capturedHandler = handler;
      return { id: 'bulk-ai-image-alt' };
    },
  },
}));

beforeEach(async () => {
  vi.resetModules();
  process.env.AI_BULK_THROTTLE_MS = '0';
  mockAssertAiQuota.mockClear();
  mockGenerateProductAltText.mockReset();
  mockReplaceText.mockReset();
  mockFindManyProduct.mockReset();
  mockUpdateProductImage.mockReset();
  mockFindUniqueJob.mockReset();
  mockUpdateJob.mockReset();

  mockFindUniqueJob.mockResolvedValue({ status: 'running' });
  mockUpdateJob.mockResolvedValue({});

  await import('../../apps/api/src/lib/inngest/functions/bulk-ai-image-alt.js');
});

async function runSweep(data: { jobId: string; storeId: string; force?: boolean }) {
  const step = { run: (_id: string, fn: () => unknown) => Promise.resolve(fn()) };
  await capturedHandler({ event: { data }, step });
}

describe('bulk-ai-image-alt sweep', () => {
  it('skips a product whose images all already have alt text', async () => {
    mockFindManyProduct.mockResolvedValue([
      {
        id: 'p1',
        name: 'Product 1',
        nameAr: null,
        images: [
          { id: 'img-1', url: 'https://x/1.jpg', alt: 'Already has alt' },
          { id: 'img-2', url: 'https://x/2.jpg', alt: 'Also has alt' },
        ],
      },
    ]);

    await runSweep({ jobId: 'job-1', storeId: 'store-1' });

    expect(mockGenerateProductAltText).not.toHaveBeenCalled();
    const finalCall = mockUpdateJob.mock.calls[mockUpdateJob.mock.calls.length - 1][0];
    expect(finalCall.data.skipped).toBe(1);
  });

  it('writes alt text only for images missing it', async () => {
    mockFindManyProduct.mockResolvedValue([
      {
        id: 'p1',
        name: 'Product 1',
        nameAr: null,
        images: [
          { id: 'img-1', url: 'https://x/1.jpg', alt: 'Already has alt' },
          { id: 'img-2', url: 'https://x/2.jpg', alt: null },
        ],
      },
    ]);
    mockGenerateProductAltText.mockResolvedValue('A generated alt string');

    await runSweep({ jobId: 'job-1', storeId: 'store-1' });

    expect(mockGenerateProductAltText).toHaveBeenCalledTimes(1);
    expect(mockGenerateProductAltText).toHaveBeenCalledWith(
      expect.objectContaining({ imageUrl: 'https://x/2.jpg' }),
      'fake-key',
      expect.any(String)
    );
    expect(mockUpdateProductImage).toHaveBeenCalledWith({
      where: { id: 'img-2' },
      data: { alt: 'A generated alt string' },
    });
    const finalCall = mockUpdateJob.mock.calls[mockUpdateJob.mock.calls.length - 1][0];
    expect(finalCall.data.filled).toBe(1);
  });

  it('counts a product as failed when every missing-alt image errors', async () => {
    mockFindManyProduct.mockResolvedValue([
      {
        id: 'p1',
        name: 'Product 1',
        nameAr: null,
        images: [{ id: 'img-1', url: 'https://x/1.jpg', alt: null }],
      },
    ]);
    mockGenerateProductAltText.mockRejectedValue(new Error('vision call failed'));

    await runSweep({ jobId: 'job-1', storeId: 'store-1' });

    expect(mockUpdateProductImage).not.toHaveBeenCalled();
    const finalCall = mockUpdateJob.mock.calls[mockUpdateJob.mock.calls.length - 1][0];
    expect(finalCall.data.failed).toBe(1);
    expect(finalCall.data.filled).toBe(0);
  });

  describe('replace existing (AITOOLS-4)', () => {
    const withAlt = [
      {
        id: 'p1',
        name: 'Product 1',
        nameAr: null,
        images: [{ id: 'img-1', url: 'https://x/1.jpg', alt: 'Old alt' }],
      },
    ];

    it('without force leaves an image that already has alt alone', async () => {
      mockFindManyProduct.mockResolvedValue(withAlt);
      await runSweep({ jobId: 'job-1', storeId: 'store-1' });
      expect(mockGenerateProductAltText).not.toHaveBeenCalled();
      expect(mockReplaceText).not.toHaveBeenCalled();
      expect(mockUpdateProductImage).not.toHaveBeenCalled();
    });

    it('force=true is ignored: an image that already has alt is never regenerated or overwritten', async () => {
      mockFindManyProduct.mockResolvedValue(withAlt);
      mockGenerateProductAltText.mockResolvedValue('Fresh alt');
      mockFindUniqueJob.mockResolvedValue({ status: 'running', userId: 'u1' });

      await runSweep({ jobId: 'job-1', storeId: 'store-1', force: true });

      expect(mockGenerateProductAltText).not.toHaveBeenCalled();
      expect(mockReplaceText).not.toHaveBeenCalled();
      expect(mockUpdateProductImage).not.toHaveBeenCalled();
    });
  });
});
