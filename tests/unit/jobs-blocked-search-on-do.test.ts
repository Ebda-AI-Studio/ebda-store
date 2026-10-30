/**
 * Ruling CF-JOBS-4B: the two product-search jobs for a store on its Durable Object. The plan and the state commit are DO ops, the
 * vectors go to Vectorize in the store's namespace, Postgres THROWS if reached. Double fire: a replayed run finds the DO state
 * current and embeds nothing (no second provider call, no second upsert). Without the Vectorize binding the job skips, loudly.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const DO_STORE = '09b5dbd1-1774-49b5-b781-e06d0ee7b0fe';
const h = vi.hoisted(() => ({
  stale: true,
  work: [] as any[],
  upserts: [] as any[],
  deletes: [] as string[],
  commits: [] as any[],
  embedCalls: 0,
  index: null as any,
  sent: [] as any[],
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
    vectorStale: async () => ({ stale: h.stale }),
    vectorPlan: async () => ({ work: h.stale ? h.work : [], orphans: [], capped: false }),
    vectorCommit: async (a: any) => {
      h.commits.push(a);
      h.stale = false;
      return { embedded: a.ready.length, cleanup: [], quarantined: a.failures.length };
    },
  }),
}));
vi.mock('@api/cf/bindings', () => ({
  cfBindings: () => (h.index ? { PRODUCT_VECTORS: h.index } : {}),
}));
vi.mock('@api/lib/search/embedding-provider', async importOriginal => ({
  ...(await importOriginal<typeof import('@api/lib/search/embedding-provider')>()),
  getEmbeddingProvider: () => ({
    model: '@cf/baai/bge-m3',
    embed: async (texts: string[]) => {
      h.embedCalls++;
      return texts.map(() => Array.from({ length: 1024 }, () => 0.1));
    },
  }),
}));
vi.mock('@api/lib/search/embed-budget', () => ({
  takeEmbedCalls: async () => true,
  alertOutageOnce: async () => undefined,
}));
vi.mock('@api/lib/inngest/client', () => ({
  inngest: { createFunction: (options: unknown, handler: unknown) => ({ options, handler }) },
}));
vi.mock('@api/lib/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('@api/services/alerts.service', () => ({ sendAlert: vi.fn(async () => 'sent') }));

import {
  handleSearchIndexBackstop,
  handleSearchProductIndex,
} from '@api/lib/inngest/functions/search-product-index';
import { PORTED_JOBS } from '@api/lib/jobs/job-data';
import { ALARM_READY } from '@api/lib/jobs/alarm-flag';
import { decideRunForStore } from '@api/lib/jobs/do-guard';

const step = {
  run: async <T>(_id: string, fn: () => Promise<T>): Promise<T> => {
    const v = await fn();
    return v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T);
  },
  sendEvent: async (_id: string, e: unknown) => void h.sent.push(e),
  sleep: async () => undefined,
};

beforeEach(() => {
  h.stale = true;
  h.work = [
    {
      productId: 'p1',
      doc: 'Lamp. A brass lamp',
      words: null,
      docHash: 'h',
      wordsHash: null,
      needDoc: true,
      needWords: false,
      key: 'k',
    },
  ];
  h.upserts.length = 0;
  h.deletes.length = 0;
  h.commits.length = 0;
  h.sent.length = 0;
  h.embedCalls = 0;
  h.index = {
    upsert: async (v: any[]) => void h.upserts.push(...v),
    deleteByIds: async (ids: string[]) => void h.deletes.push(...ids),
  };
  vi.stubEnv('JOBS_ON_DO', '1');
  vi.stubEnv('STORE_DO_ENABLED_IDS', DO_STORE);
  vi.stubEnv('SEARCH_EMBED_THROTTLE_MS', '0');
});

describe('the search jobs are ported', () => {
  it.each(['search-product-index', 'search-index-backstop'])('%s', id => {
    expect(PORTED_JOBS.has(id)).toBe(true);
    expect(decideRunForStore({ id } as never, DO_STORE)).toEqual({ run: true });
  });
  it('the backstop is alarm-armed', () =>
    expect(ALARM_READY.has('search-index-backstop')).toBe(true));
});

describe('search-product-index on a DO store', () => {
  const event = { data: { storeId: DO_STORE } };

  it('embeds the planned product, upserts into the store namespace and commits the DO state', async () => {
    const out = await handleSearchProductIndex({ event, step: step as never });
    expect(out).toMatchObject({ embedded: 1, done: true });
    expect(h.upserts).toHaveLength(1);
    expect(h.upserts[0]).toMatchObject({ id: 'p1:d', namespace: DO_STORE });
    expect(h.upserts[0].metadata).toMatchObject({
      storeId: DO_STORE,
      productId: 'p1',
      kind: 'doc',
    });
    expect(h.commits[0].ready.map((w: any) => w.productId)).toEqual(['p1']);
  });

  it('double fire: the replay finds the DO state current and embeds nothing', async () => {
    await handleSearchProductIndex({ event, step: step as never });
    const again = await handleSearchProductIndex({ event, step: step as never });
    expect(again).toMatchObject({ embedded: 0, done: true });
    expect(h.embedCalls).toBe(1);
    expect(h.upserts).toHaveLength(1);
  });

  it('without a Vectorize binding it skips and writes nothing', async () => {
    h.index = null;
    expect(await handleSearchProductIndex({ event, step: step as never })).toMatchObject({
      skipped: 'no-vector-index',
    });
    expect(h.commits).toHaveLength(0);
    expect(h.embedCalls).toBe(0);
  });
});

describe('search-index-backstop on a DO store alarm', () => {
  const alarm = { data: { alarm: true, storeId: DO_STORE } };

  it('asks the DO and fans one reindex event for a stale store, none for a current one', async () => {
    expect(await handleSearchIndexBackstop({ step: step as never, event: alarm })).toEqual({
      stores: 1,
      failed: 0,
    });
    expect(h.sent).toHaveLength(1);
    h.stale = false;
    h.sent.length = 0;
    expect(await handleSearchIndexBackstop({ step: step as never, event: alarm })).toEqual({
      stores: 0,
      failed: 0,
    });
    expect(h.sent).toHaveLength(0);
  });
});
