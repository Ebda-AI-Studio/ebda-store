/**
 * Ruling CF-VEC-1: the storefront vector leg of a store on its Durable Object reads Vectorize (PRODUCT_VECTORS, namespace = store
 * id), lets the DO decide visibility, never touches Postgres halfvec, and is FAIL-SOFT: no binding or a Vectorize error returns the
 * keyword order and reports `degraded` so the list is not cached as the full answer.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const DO_STORE = '09b5dbd1-1774-49b5-b781-e06d0ee7b0fe';
const h = vi.hoisted(() => ({
  index: null as any,
  lexical: [] as string[],
  visible: null as string[] | null,
  visibleAsked: [] as string[][],
  boom: (what: string): object =>
    new Proxy(
      {},
      {
        get: (_t, p) => {
          throw new Error(`Postgres touched: ${what}.${String(p)}`);
        },
      }
    ),
}));
vi.mock('@ebda/database', async () =>
  (await import('./helpers/database-mock')).databaseMock({
    prisma: h.boom('prisma'),
    extra: { Prisma: { sql: () => ({}), join: () => ({}) } },
  })
);
vi.mock('@api/lib/repo-factory', () => ({
  storeMoney: async () => ({
    searchProducts: async () => ({ ids: h.lexical, truncated: false }),
    vectorVisible: async (a: { ids: string[] }) => {
      h.visibleAsked.push(a.ids);
      return { ids: h.visible ?? a.ids };
    },
  }),
}));
vi.mock('@api/cf/bindings', () => ({
  cfBindings: () => (h.index ? { PRODUCT_VECTORS: h.index } : {}),
}));
vi.mock('@api/lib/search/embed-budget', () => ({
  takeQueryEmbed: async () => true,
  queryBudgetSpent: () => false,
}));
vi.mock('@api/lib/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { setEmbeddingProviderForTests, EMBED_MODEL } =
  await import('@api/lib/search/embedding-provider');
const { rankedSearchWithMode, clearQueryVectorCacheForTests, queryEmbedText } =
  await import('@api/services/product-search.service');

const unit = (n: number) => Array.from({ length: 1024 }, () => n);

beforeEach(() => {
  process.env.SEARCH_SEMANTIC_ENABLED = 'true';
  clearQueryVectorCacheForTests();
  h.lexical = [];
  h.visible = null;
  h.visibleAsked.length = 0;
  h.index = {
    query: vi.fn(async () => ({
      matches: [
        { id: 'pA:d', score: 0.8 },
        { id: 'pA:w', score: 0.9 }, // pA's nearer vector wins
        { id: 'pB:d', score: 0.85 }, // within the 0.10 band of the best (0.9)
        { id: 'pFar:d', score: 0.2 }, // distance 0.8 > max
        { id: 'pHidden:d', score: 0.85 },
      ],
    })),
  };
  setEmbeddingProviderForTests({ model: EMBED_MODEL, embed: async t => t.map(() => unit(0.1)) });
});

describe('the vector leg of a DO store (Ruling CF-VEC-1)', () => {
  it('queries Vectorize in the store namespace, keeps the nearer vector, drops far and hidden products', async () => {
    h.visible = ['pA', 'pB', 'pFar'];
    const r = await rankedSearchWithMode(DO_STORE, 'brass lamp', { searcher: 'ip:1' });
    expect(r).toEqual({ ids: ['pA', 'pB'], degraded: false });
    expect(h.index.query.mock.calls[0][1]).toMatchObject({ namespace: DO_STORE });
    // production has no metadata index: a filter matches nothing (Ruling SEARCH-SEMANTIC-LIVE-2)
    expect(h.index.query.mock.calls[0][1]).not.toHaveProperty('filter');
    // the DO is asked only about products inside the distance bound
    expect(h.visibleAsked[0].sort()).toEqual(['pA', 'pB', 'pHidden']);
  });

  it('fuses with the keyword leg and keeps keyword-only products', async () => {
    h.lexical = ['kw1', 'pB'];
    h.visible = ['pA', 'pB'];
    const r = await rankedSearchWithMode(DO_STORE, 'brass lamp', { searcher: 'ip:1' });
    expect(new Set(r.ids)).toEqual(new Set(['kw1', 'pB', 'pA']));
    expect(r.degraded).toBe(false);
  });

  it('FAIL-SOFT: no PRODUCT_VECTORS binding returns the keyword order and degraded', async () => {
    h.index = null;
    h.lexical = ['kw1', 'kw2'];
    const r = await rankedSearchWithMode(DO_STORE, 'brass lamp', { searcher: 'ip:1' });
    expect(r).toEqual({ ids: ['kw1', 'kw2'], degraded: true });
  });

  it('FAIL-SOFT: a Vectorize error returns the keyword order and degraded, never throws', async () => {
    h.index.query = vi.fn(async () => {
      throw new Error('vectorize 503');
    });
    h.lexical = ['kw1'];
    const r = await rankedSearchWithMode(DO_STORE, 'brass lamp', { searcher: 'ip:1' });
    expect(r).toEqual({ ids: ['kw1'], degraded: true });
  });
});

// Measured on production bge-m3 against Amelia Aurum (2026-11-11, Ruling SEARCH-SEMANTIC-LIVE-3): top-3 cosine scores
// of the embedded (folded + colloquial->standard) query. `relevant` = the answer a shopper expects.
const MEASURED: Array<{ q: string; embed: string; top: number[]; relevant: boolean }> = [
  { q: 'هدية لمراتي', embed: 'هديه لزوجتي', top: [0.47, 0.46, 0.46], relevant: true },
  { q: 'حاجة للبحر', embed: 'شيء للبحر', top: [0.52, 0.51, 0.49], relevant: true },
  { q: 'gift for my wife', embed: 'gift for my wife', top: [0.48, 0.46, 0.46], relevant: true },
  {
    q: 'something for the sea',
    embed: 'something for the sea',
    top: [0.54, 0.53, 0.52],
    relevant: true,
  },
  { q: 'خاتم', embed: 'خاتم', top: [0.59, 0.55, 0.47], relevant: true },
  { q: 'حلق', embed: 'حلق', top: [0.66, 0.61, 0.56], relevant: true },
  { q: 'شاحن موبايل', embed: 'شاحن موبايل', top: [0.39, 0.38, 0.38], relevant: false },
  { q: 'pizza', embed: 'pizza', top: [0.4, 0.4, 0.38], relevant: false },
];

describe('measured production scores (Ruling SEARCH-SEMANTIC-LIVE-3)', () => {
  it.each(MEASURED)('$q', async ({ q, embed, top, relevant }) => {
    expect(queryEmbedText(q)).toBe(embed);
    h.index.query = vi.fn(async () => ({
      matches: top.map((score, i) => ({ id: `p${i}:d`, score })),
    }));
    const r = await rankedSearchWithMode(DO_STORE, q, { searcher: 'ip:1' });
    expect(r.ids.length > 0).toBe(relevant);
  });

  it('KNOWN RESIDUAL: "laptop charger" tops at 0.50, above the relevant «هدية لزوجتي» 0.47, so a score cut cannot drop it', async () => {
    h.index.query = vi.fn(async () => ({
      matches: [0.5, 0.43, 0.4].map((score, i) => ({ id: `p${i}:d`, score })),
    }));
    const r = await rankedSearchWithMode(DO_STORE, 'laptop charger', { searcher: 'ip:1' });
    expect(r.ids).toEqual(['p0']); // one product (band), not three
  });
});
