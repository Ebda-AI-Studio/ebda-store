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
  BUDGET_STEP_TIMEOUT_MS,
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

  it('REALISTIC DO latency (150 ms per call): a WARM, uncached query is NOT degraded (the 6/6 production failure)', async () => {
    incrDelayMs = 150;
    const t0 = Date.now();
    const ids = await semanticProductIds(STORE, 'kotshy abyad', { searcher: 'ip:1.2.3.4' });
    expect(embed).toHaveBeenCalledTimes(1);
    expect(ids).toEqual([]); // no DB in this test: the leg ran, found nothing, did not time out
    // ONE parallel DO round trip: far under the old serial 4+ x 150 ms that lost the 400 ms race
    expect(Date.now() - t0).toBeLessThan(450);
    expect(client.incr).toHaveBeenCalledTimes(4); // searcher + 3 daily counters, together
  });

  it('a slow EMBED still loses the race (warm 400 ms), with the provider aborted', async () => {
    embed.mockImplementationOnce(
      (async (_t: string[], o?: { signal?: AbortSignal }) =>
        new Promise((_res, rej) =>
          o?.signal?.addEventListener('abort', () => rej(new Error('aborted')))
        )) as never
    );
    const t0 = Date.now();
    await semanticProductIds(STORE, 'kotshy abyad', { searcher: 'ip:1.2.3.4' });
    expect(Date.now() - t0).toBeLessThan(QUERY_EMBED_BUDGET_MS + 300);
  });

  it('COLD isolate keeps the 1200 ms safety net for the embed', () => {
    expect(QUERY_EMBED_COLD_BUDGET_MS).toBe(1200);
    setLastQueryEmbedOkAtForTests(0);
  });

  it('a budget step slower than BUDGET_STEP_TIMEOUT_MS fails CLOSED: no provider call, ends on time', async () => {
    incrDelayMs = 1500;
    const t0 = Date.now();
    const ids = await semanticProductIds(STORE, 'kotshy abyad', { searcher: 'ip:1.2.3.4' });
    expect(ids).toEqual([]);
    expect(Date.now() - t0).toBeLessThan(BUDGET_STEP_TIMEOUT_MS + 300);
    await new Promise(r => setTimeout(r, 1700)); // let the slow budget answer arrive
    expect(embed).not.toHaveBeenCalled();
  });
});
