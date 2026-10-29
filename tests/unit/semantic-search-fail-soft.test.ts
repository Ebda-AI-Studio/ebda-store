/**
 * Ruling SEARCH-SEMANTIC-ON-1: with SEARCH_SEMANTIC_ENABLED=true, an AI-binding failure (provider
 * error, timeout, bad shape, plain throw) never breaks storefront search. The vector leg resolves
 * to [] (keyword results only) and never throws.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const client = {
  incr: vi.fn(async () => 1),
  expire: vi.fn(async () => 1),
  decr: vi.fn(async () => 0),
  set: vi.fn(async () => 'OK'),
};
vi.mock('../../apps/api/src/services/redis.service', () => ({
  redis: { getClient: () => client, isAvailable: () => true },
}));
vi.mock('../../apps/api/src/services/alerts.service', () => ({ sendAlert: vi.fn() }));

const { setEmbeddingProviderForTests, EMBED_MODEL, EmbeddingError } =
  await import('../../apps/api/src/lib/search/embedding-provider');
const { semanticProductIds, clearQueryVectorCacheForTests } =
  await import('../../apps/api/src/services/product-search.service');
const { clearQueryBudgetSpentForTests } =
  await import('../../apps/api/src/lib/search/embed-budget');

const STORE = '11111111-1111-4111-8111-111111111111';
const failures: Array<[string, () => Error]> = [
  ['provider 5xx', () => new EmbeddingError('provider', 'AI binding 500')],
  ['timeout', () => new EmbeddingError('timeout', 'timed out')],
  ['plain throw', () => new Error('binding unavailable')],
];

describe('semantic leg is fail-soft when the AI binding errors', () => {
  beforeEach(() => {
    process.env.SEARCH_SEMANTIC_ENABLED = 'true';
    clearQueryVectorCacheForTests();
    clearQueryBudgetSpentForTests();
  });
  afterEach(() => {
    setEmbeddingProviderForTests(undefined);
    delete process.env.SEARCH_SEMANTIC_ENABLED;
  });

  it.each(failures)('%s -> [] and no throw', async (_n, make) => {
    const embed = vi.fn(async () => {
      throw make();
    });
    setEmbeddingProviderForTests({ model: EMBED_MODEL, embed });
    await expect(
      semanticProductIds(STORE, 'kotshy abyad', { searcher: 'ip:1.2.3.4' })
    ).resolves.toEqual([]);
    expect(embed).toHaveBeenCalled(); // the leg really ran and failed, not skipped
  });
});
