import { describe, it, expect, vi } from 'vitest';

vi.mock('@ebda/database', () => ({ Prisma: {} }));
const upsert = vi.fn(async () => undefined);
const deleteByIds = vi.fn(async () => undefined);
const money = {
  vectorPlan: vi.fn(),
  vectorStale: vi.fn(),
  vectorCommit: vi.fn(),
};
vi.mock('@api/cf/bindings', () => ({
  cfBindings: () => ({ PRODUCT_VECTORS: { upsert, deleteByIds } }),
}));
vi.mock('@api/lib/repo-factory', () => ({ storeMoney: async () => money }));
vi.mock('@api/lib/search/embedding-provider', () => ({
  EMBED_MAX_BATCH: 100,
  EmbeddingError: class extends Error {},
  getEmbeddingProvider: () => ({ embed: async (t: string[]) => t.map(() => [0.1]) }),
}));
vi.mock('@api/services/product-index.service', () => ({
  embedStoreDailyCap: () => 100,
  embedThrottleMs: () => 0,
}));
vi.mock('@api/lib/search/embed-budget', () => ({ takeEmbedCalls: async () => true }));

import { AppError } from '@api/middleware/error-handler';
import { indexRoundsDo } from '@api/lib/search/do-index';

const step = { run: async (_n: string, fn: () => Promise<unknown>) => fn() };

describe('indexRoundsDo and a deleted store (audit P2-7)', () => {
  it('a store closed while the embeds were in flight: the upsert never lands', async () => {
    upsert.mockClear();
    money.vectorPlan.mockResolvedValue({
      work: [
        { productId: 'p1', needDoc: true, doc: 'ring', needWords: false, words: null, key: 'k' },
      ],
      orphans: [],
      capped: false,
    });
    money.vectorStale.mockRejectedValue(new AppError(410, 'STORE_CLOSED', 'closed'));
    const r = await indexRoundsDo('s1', step as never, 1, 3, { permanent: 0, temporary: 0 });
    expect(upsert).not.toHaveBeenCalled();
    expect(money.vectorCommit).not.toHaveBeenCalled();
    expect(r).toMatchObject({ skipped: 'store-gone' });
  });

  it('a store already closed at plan time: nothing planned, no error', async () => {
    money.vectorPlan.mockRejectedValue(new AppError(410, 'STORE_CLOSED', 'closed'));
    const r = await indexRoundsDo('s1', step as never, 1, 3, { permanent: 0, temporary: 0 });
    expect(r).toMatchObject({ done: true });
  });
});
