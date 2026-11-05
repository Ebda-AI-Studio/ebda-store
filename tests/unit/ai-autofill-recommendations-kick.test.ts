/**
 * #1937 — the AI recommendations sweep used to be kicked from inside the
 * debounced `product.upserted` Inngest handler on `op === 'create'`. That
 * handler debounces on `productId` for 10s and Inngest delivers only the
 * LAST event in a debounce window: a create followed by a quick edit within
 * 10s coalesced into one `op: 'update'` delivery, silently skipping the
 * kick every time.
 *
 * `enqueueRecommendationsSweepForNewProduct` moves the kick to the one true
 * creation site (`ProductService.create()`), decoupled from debounce
 * entirely. This tests the helper directly — its coalescing guard (skip if
 * a sweep is already queued/running) and that a failure never throws (the
 * product create must not be blocked by this).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../apps/api/src/lib/logger', () => ({
  default: { warn: vi.fn(), debug: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

const mockBulkAiJobFindFirst = vi.fn();
const mockBulkAiJobCreate = vi.fn();
const mockBulkAiJobUpdate = vi.fn();
vi.mock('@ebda/database', () => ({
  prisma: {
    bulkAiJob: {
      findFirst: (...args: unknown[]) => mockBulkAiJobFindFirst(...args),
      create: (...args: unknown[]) => mockBulkAiJobCreate(...args),
      update: (...args: unknown[]) => mockBulkAiJobUpdate(...args),
    },
  },
  // Outside a tenant context: withSavepoint is a pass-through, and the
  // deferred drain's fresh tenant tx just invokes the callback.
  hasTenantContext: () => false,
  runInTenantContext: async (_s: string, fn: () => Promise<unknown>) => fn(),
  onClosedTenantTxAccess: vi.fn(),
}));
vi.mock('../../apps/api/src/services/alerts.service', () => ({ sendAlert: vi.fn() }));

const mockInngestSend = vi.fn();
vi.mock('../../apps/api/src/lib/inngest/client', () => ({
  inngest: { send: (...args: unknown[]) => mockInngestSend(...args) },
}));

import { enqueueRecommendationsSweepForNewProduct } from '../../apps/api/src/services/ai-autofill.service';
import { withDeferredWork } from '../../apps/api/src/lib/after-tenant-commit';

const STORE_ID = '11111111-1111-1111-1111-111111111111';
const PRODUCT_ID = '22222222-2222-2222-2222-222222222222';

beforeEach(() => {
  vi.clearAllMocks();
  mockBulkAiJobFindFirst.mockResolvedValue(null);
  mockBulkAiJobCreate.mockResolvedValue({ id: 'job-1' });
  mockInngestSend.mockResolvedValue(undefined);
  mockBulkAiJobUpdate.mockResolvedValue({});
});

describe('enqueueRecommendationsSweepForNewProduct', () => {
  it('creates a system-initiated recommendations job and sends the event', async () => {
    await enqueueRecommendationsSweepForNewProduct(STORE_ID, PRODUCT_ID);

    expect(mockBulkAiJobFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          storeId: STORE_ID,
          kind: 'recommendations',
          status: { in: ['queued', 'running'] },
        },
      })
    );
    expect(mockBulkAiJobCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { storeId: STORE_ID, userId: null, kind: 'recommendations' },
      })
    );
    expect(mockInngestSend).toHaveBeenCalledWith({
      name: 'bulk-ai/recommendations-requested',
      data: { jobId: 'job-1', storeId: STORE_ID, force: false },
    });
  });

  it('coalesces: skips creating a second job when one is already queued/running for this store', async () => {
    mockBulkAiJobFindFirst.mockResolvedValue({ id: 'existing-job' });

    await enqueueRecommendationsSweepForNewProduct(STORE_ID, PRODUCT_ID);

    expect(mockBulkAiJobCreate).not.toHaveBeenCalled();
    expect(mockInngestSend).not.toHaveBeenCalled();
  });

  it('never throws — a failure must not block the product create it is called from', async () => {
    mockBulkAiJobCreate.mockRejectedValue(new Error('DB blip'));

    await expect(
      enqueueRecommendationsSweepForNewProduct(STORE_ID, PRODUCT_ID)
    ).resolves.toBeUndefined();
  });

  // Ruling JOBS-ORPHAN-1: the 2026-11-02 prod row sat `queued` for 44 h because a failed send was only logged.
  it('send throws -> the job row is marked failed (never an orphan queued row), still non-fatal', async () => {
    mockInngestSend.mockRejectedValue(new Error('no runner'));

    await expect(
      enqueueRecommendationsSweepForNewProduct(STORE_ID, PRODUCT_ID)
    ).resolves.toBeUndefined();

    expect(mockBulkAiJobUpdate).toHaveBeenCalledTimes(1);
    expect(mockBulkAiJobUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'job-1', storeId: STORE_ID },
        data: expect.objectContaining({ status: 'failed', errorMessage: expect.any(String) }),
      })
    );
  });

  it('send succeeds -> the job row is left alone', async () => {
    await enqueueRecommendationsSweepForNewProduct(STORE_ID, PRODUCT_ID);
    expect(mockBulkAiJobUpdate).not.toHaveBeenCalled();
  });

  // Issues 2108 / 2214 / 2215: inside a request the kick must wait for the
  // product's COMMIT — never publish a jobId for an uncommitted row, never
  // run a bulkAiJob query that could abort the request transaction.
  it('inside a request, runs only AFTER the tenant transaction commits', async () => {
    await withDeferredWork({ storeId: STORE_ID }, async () => {
      await enqueueRecommendationsSweepForNewProduct(STORE_ID, PRODUCT_ID);
      // Still inside the (uncommitted) request transaction: nothing ran.
      expect(mockBulkAiJobFindFirst).not.toHaveBeenCalled();
      expect(mockBulkAiJobCreate).not.toHaveBeenCalled();
      expect(mockInngestSend).not.toHaveBeenCalled();
    });
    // Committed → drained.
    expect(mockBulkAiJobCreate).toHaveBeenCalledTimes(1);
    expect(mockInngestSend).toHaveBeenCalledTimes(1);
  });

  it('a rolled-back create drops the kick — no orphan job, no event', async () => {
    await expect(
      withDeferredWork({ storeId: STORE_ID }, async () => {
        await enqueueRecommendationsSweepForNewProduct(STORE_ID, PRODUCT_ID);
        throw new Error('request rolled back');
      })
    ).rejects.toThrow('request rolled back');
    expect(mockBulkAiJobCreate).not.toHaveBeenCalled();
    expect(mockInngestSend).not.toHaveBeenCalled();
  });
});
