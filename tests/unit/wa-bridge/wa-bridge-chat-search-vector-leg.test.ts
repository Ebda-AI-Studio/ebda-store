/**
 * Ruling CHAT-AGENT-6: Chat's search reaches the meaning leg. Real `rankedSearchWithMode`, a budget gate that is default-deny exactly
 * like production (no searcher = no embed), a stubbed embedder + Vectorize. A query with NO keyword hit must still find the product
 * when Chat passes its searcher id, and must be reported `degraded` (never a silent empty) when the gate refuses.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const STORE = '09b5dbd1-1774-49b5-b781-e06d0ee7b0fe';
const h = vi.hoisted(() => ({ index: null as any, refuse: false, searchers: [] as unknown[] }));
vi.mock('@ebda/database', async () =>
  (await import('../helpers/database-mock')).databaseMock({
    prisma: {},
    extra: { Prisma: { sql: () => ({}), join: () => ({}) } },
  })
);
vi.mock('@api/lib/repo-factory', () => ({
  storeMoney: async () => ({
    searchProducts: async () => ({ ids: [], truncated: false }),
    vectorVisible: async (a: { ids: string[] }) => ({ ids: a.ids }),
  }),
}));
vi.mock('@api/cf/bindings', () => ({
  cfBindings: () => (h.index ? { PRODUCT_VECTORS: h.index } : {}),
}));
vi.mock('@api/lib/search/embed-budget', () => ({
  takeQueryEmbed: async (_store: string, searcher: string | undefined) => {
    h.searchers.push(searcher);
    return !!searcher && !h.refuse;
  },
  queryBudgetSpent: () => false,
}));
vi.mock('@api/lib/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { setEmbeddingProviderForTests, EMBED_MODEL } =
  await import('@api/lib/search/embedding-provider');
const { rankedSearchWithMode, clearQueryVectorCacheForTests } =
  await import('@api/services/product-search.service');
const { chatSearcherId } = await import('@api/lib/wa/bridge/searcher');

beforeEach(() => {
  process.env.SEARCH_SEMANTIC_ENABLED = 'true';
  clearQueryVectorCacheForTests();
  h.refuse = false;
  h.searchers.length = 0;
  h.index = { query: vi.fn(async () => ({ matches: [{ id: 'pGift:d', score: 0.9 }] })) };
  setEmbeddingProviderForTests({
    model: EMBED_MODEL,
    embed: async t => t.map(() => Array.from({ length: 1024 }, () => 0.1)),
  });
});

describe('Chat search reaches the meaning leg (Ruling CHAT-AGENT-6)', () => {
  it('a dialect query with no keyword hit finds the product through the vector leg', async () => {
    const r = await rankedSearchWithMode(STORE, 'حاجة تتهدي', { searcher: chatSearcherId(STORE) });
    expect(r).toEqual({ ids: ['pGift'], degraded: false });
    expect(h.searchers).toEqual([`wa-chat:${STORE}`]);
  });
  it('without a searcher the gate refuses: empty AND degraded (the bug this ruling fixes)', async () => {
    const r = await rankedSearchWithMode(STORE, 'حاجة تتهدي', {});
    expect(r).toEqual({ ids: [], degraded: true });
  });
  it('a spent budget is degraded, never a silent empty', async () => {
    h.refuse = true;
    const r = await rankedSearchWithMode(STORE, 'حاجة تتهدي', { searcher: chatSearcherId(STORE) });
    expect(r).toEqual({ ids: [], degraded: true });
  });
  it('the searcher id is namespaced per store and per shopper, and ignores malformed input', () => {
    expect(chatSearcherId(STORE, 'k1')).toBe(`wa-chat:${STORE}:k1`);
    expect(chatSearcherId(STORE, 'a b')).toBe(`wa-chat:${STORE}`);
    expect(chatSearcherId(STORE, 'x'.repeat(65))).toBe(`wa-chat:${STORE}`);
    expect(chatSearcherId(STORE).startsWith('ip:')).toBe(false);
  });
});
