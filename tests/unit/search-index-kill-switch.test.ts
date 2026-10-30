/**
 * Ruling SEARCH-T11-8: `SEARCH_EMBED_STORE_DAILY_CAP=0` is the indexer's kill switch. With it,
 * neither the in-process indexer nor the Inngest function makes a Workers AI call, even with a
 * provider bound and stale products waiting. The database is faked (every count says "stale").
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const queries: string[] = [];
vi.mock('@ebda/database', async importOriginal => {
  const real = await importOriginal<typeof import('@ebda/database')>();
  // A tagged-template call passes the TemplateStringsArray; nested Prisma.sql fragments are values.
  const sqlOf = (q: unknown, values: unknown[]): string =>
    [
      ...(Array.isArray(q) ? q : []),
      ...values.map(v => ((v as { strings?: string[] })?.strings ?? []).join(' ')),
    ].join(' ');
  return {
    ...real,
    runInStoreScope: (_s: string, fn: () => Promise<unknown>) => fn(),
    prisma: {
      $queryRaw: vi.fn(async (q: unknown, ...values: unknown[]) => {
        const sql = sqlOf(q, values);
        queries.push(sql);
        if (sql.includes('embedded_at >=')) return [{ n: 0n }];
        if (sql.includes('AS stale')) return [{ stale: true }]; // hasStaleProducts (the finder has EXISTS too)
        return [
          {
            id: 'p1',
            doc: 'Shoes',
            hash: 'h',
            words: null,
            wordsHash: null,
            key: 'k',
            needDoc: true,
            needWords: false,
          },
        ];
      }),
      $executeRaw: vi.fn(async () => 0),
    },
  };
});
// The account-wide Redis budget (SEARCH-T11-19) is not what this file tests: always grant it.
vi.mock('../../apps/api/src/lib/search/embed-budget', () => ({
  takeEmbedCalls: vi.fn(async () => true),
}));
vi.mock('../../apps/api/src/lib/inngest/client', () => ({
  inngest: { send: vi.fn(), createFunction: vi.fn(() => ({})) },
}));

const { setEmbeddingProviderForTests, EMBED_MODEL } =
  await import('../../apps/api/src/lib/search/embedding-provider');
const { indexStore } = await import('../../apps/api/src/services/product-index.service');
const { handleSearchProductIndex } =
  await import('../../apps/api/src/lib/inngest/functions/search-product-index');

const STORE = '11111111-1111-4111-8111-111111111111';
const embed = vi.fn(async (texts: string[]) => texts.map(() => new Array(1024).fill(0.1)));

describe('SEARCH_EMBED_STORE_DAILY_CAP=0 kill switch (SEARCH-T11-8)', () => {
  beforeEach(() => {
    embed.mockClear();
    queries.length = 0;
    setEmbeddingProviderForTests({ model: EMBED_MODEL, embed });
    process.env.SEARCH_EMBED_STORE_DAILY_CAP = '0';
    process.env.SEARCH_EMBED_THROTTLE_MS = '0';
  });
  afterEach(() => {
    setEmbeddingProviderForTests(undefined);
    delete process.env.SEARCH_EMBED_STORE_DAILY_CAP;
  });

  it('indexStore: capped, no provider call', async () => {
    expect(await indexStore(STORE)).toMatchObject({ embedded: 0, capped: true });
    expect(queries.some(q => q.includes('embedded_at >='))).toBe(true);
    expect(embed).not.toHaveBeenCalled();
  });

  it('the Inngest handler: one plan step, capped, no provider call', async () => {
    const steps: string[] = [];
    const step = {
      run: async (name: string, fn: () => Promise<unknown>) => {
        steps.push(name);
        return JSON.parse(JSON.stringify((await fn()) ?? null));
      },
      sendEvent: vi.fn(),
    };
    const r = await handleSearchProductIndex({ event: { data: { storeId: STORE } }, step });
    expect(r).toMatchObject({ capped: true });
    expect(steps).toEqual(['is-do-store', 'plan-0']); // the D1 backend flag read is its own step; still ONE plan step
    expect(embed).not.toHaveBeenCalled();
  });

  it('control: with the cap lifted the same fake DB does reach the provider', async () => {
    delete process.env.SEARCH_EMBED_STORE_DAILY_CAP;
    await indexStore(STORE, { maxDocs: 1 });
    expect(embed).toHaveBeenCalledTimes(1);
  });
});
