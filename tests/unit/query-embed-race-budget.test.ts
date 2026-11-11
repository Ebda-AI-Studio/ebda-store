/**
 * Task 12 review M3: E11's ~400 ms race bounds the WHOLE query-embed step, the budget round trips
 * (AuthState DO on the Worker) included, not just the provider call. A slow budget answer must not
 * hold the storefront request past the budget, and must not reach the provider afterwards.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

let incrDelayMs = 0;
const client = {
  incr: vi.fn(async () => {
    await new Promise(r => setTimeout(r, incrDelayMs));
    return 1;
  }),
  expire: vi.fn(async () => 1),
  decr: vi.fn(async () => 0),
  set: vi.fn(async () => 'OK'),
};
vi.mock('../../apps/api/src/services/redis.service', () => ({
  redis: { getClient: () => client, isAvailable: () => true },
}));
vi.mock('../../apps/api/src/services/alerts.service', () => ({ sendAlert: vi.fn() }));

const { setEmbeddingProviderForTests, EMBED_MODEL, EMBED_DIMS } =
  await import('../../apps/api/src/lib/search/embedding-provider');
const {
  semanticProductIds,
  clearQueryVectorCacheForTests,
  QUERY_EMBED_BUDGET_MS,
  QUERY_EMBED_COLD_BUDGET_MS,
  setLastQueryEmbedOkAtForTests,
} = await import('../../apps/api/src/services/product-search.service');
const { clearQueryBudgetSpentForTests } =
  await import('../../apps/api/src/lib/search/embed-budget');

const STORE = '11111111-1111-4111-8111-111111111111';
const embed = vi.fn(async (t: string[]) => t.map(() => new Array(EMBED_DIMS).fill(0.1)));

describe('query embed race covers the budget step (M3)', () => {
  beforeEach(() => {
    process.env.SEARCH_SEMANTIC_ENABLED = 'true';
    setEmbeddingProviderForTests({ model: EMBED_MODEL, embed });
    clearQueryVectorCacheForTests();
    clearQueryBudgetSpentForTests();
    embed.mockClear();
    setLastQueryEmbedOkAtForTests(Date.now()); // warm unless a test says otherwise
  });
  afterEach(() => {
    setEmbeddingProviderForTests(undefined);
    delete process.env.SEARCH_SEMANTIC_ENABLED;
    incrDelayMs = 0;
  });

  it('COLD isolate: a ~900 ms budget step still wins the race (first search after idle is not degraded)', async () => {
    setLastQueryEmbedOkAtForTests(0);
    incrDelayMs = 450; // two sequential incr steps: ~900 ms total
    expect(QUERY_EMBED_COLD_BUDGET_MS).toBeGreaterThan(900 + 150);
    await semanticProductIds(STORE, 'kotshy abyad', { searcher: 'ip:1.2.3.4' });
    expect(embed).toHaveBeenCalledTimes(1);
  });

  it('WARM isolate: the same ~900 ms step loses the 400 ms race (budget unchanged when warm)', async () => {
    incrDelayMs = 450; // two sequential incr steps: ~900 ms total
    await semanticProductIds(STORE, 'kotshy abyad', { searcher: 'ip:1.2.3.4' });
    await new Promise(r => setTimeout(r, 1000));
    expect(embed).not.toHaveBeenCalled();
  });

  it('a budget step slower than the race ends the leg on time, and the provider is never called', async () => {
    incrDelayMs = 1500;
    const t0 = Date.now();
    const ids = await semanticProductIds(STORE, 'kotshy abyad', { searcher: 'ip:1.2.3.4' });
    const took = Date.now() - t0;
    expect(ids).toEqual([]);
    expect(took).toBeLessThan(QUERY_EMBED_BUDGET_MS + 300);
    await new Promise(r => setTimeout(r, 1700)); // let the slow budget answer arrive
    expect(embed).not.toHaveBeenCalled();
  });
});
