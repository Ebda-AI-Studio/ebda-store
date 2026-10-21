/**
 * Task 11: `requestStoreReindex` — deferred past the tenant COMMIT inside a request, inline
 * elsewhere, silent with no embedding provider, and it never throws.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const send = vi.fn(async (_e: unknown) => ({ ids: [] as string[] }));
vi.mock('../../apps/api/src/lib/inngest/client', () => ({ inngest: { send } }));
vi.mock('../../apps/api/src/services/alerts.service', () => ({ sendAlert: vi.fn(async () => {}) }));
vi.mock('@ebda/database', async importOriginal => ({
  ...(await importOriginal<typeof import('@ebda/database')>()),
  // The drain re-opens a tenant transaction per task; no database in a unit test.
  runInTenantContext: (_s: string, fn: () => Promise<unknown>) => fn(),
}));

const { requestStoreReindex, touchesEmbedDoc } =
  await import('../../apps/api/src/lib/search/reindex');
const { withDeferredWork } = await import('../../apps/api/src/lib/after-tenant-commit');
const { setEmbeddingProviderForTests, EMBED_MODEL } =
  await import('../../apps/api/src/lib/search/embedding-provider');

const STORE = '11111111-1111-4111-8111-111111111111';
const provider = { model: EMBED_MODEL, embed: async () => [] };

describe('requestStoreReindex', () => {
  beforeEach(() => {
    send.mockClear();
    setEmbeddingProviderForTests(provider);
  });
  afterEach(() => setEmbeddingProviderForTests(undefined));

  it('outside a request: sends the event inline', async () => {
    await requestStoreReindex(STORE, 'bulk-import');
    expect(send).toHaveBeenCalledWith({
      name: 'search/store.reindex-requested',
      data: { storeId: STORE, reason: 'bulk-import' },
    });
  });

  it('inside a request: nothing is sent until the transaction has committed', async () => {
    let sentBeforeCommit = -1;
    await withDeferredWork({ storeId: STORE }, async () => {
      await requestStoreReindex(STORE, 'ai-handback');
      sentBeforeCommit = send.mock.calls.length;
    });
    expect(sentBeforeCommit).toBe(0);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('a rolled-back request sends nothing', async () => {
    await expect(
      withDeferredWork({ storeId: STORE }, async () => {
        await requestStoreReindex(STORE, 'ai-autofill');
        throw new Error('rollback');
      })
    ).rejects.toThrow('rollback');
    expect(send).not.toHaveBeenCalled();
  });

  it('never throws when the enqueue fails', async () => {
    send.mockRejectedValueOnce(new Error('inngest down'));
    await expect(requestStoreReindex(STORE, 'x')).resolves.toBeUndefined();
  });

  it('no embedding provider: sends nothing (the consumer would only skip)', async () => {
    setEmbeddingProviderForTests(null);
    await requestStoreReindex(STORE, 'x');
    expect(send).not.toHaveBeenCalled();
  });

  it('touchesEmbedDoc knows the four doc columns AND the search words, which have their own vector (SEARCH-T13-7)', () => {
    expect(touchesEmbedDoc(['metaTitle', 'description'])).toBe(true);
    expect(touchesEmbedDoc(['searchTerms'])).toBe(true);
    expect(touchesEmbedDoc(['excerpt', 'metaDescription', 'inventory'])).toBe(false);
  });
});
