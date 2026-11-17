/**
 * Ruling CF-JOBS-4B + NZ-AN-1: the two GSC ingest jobs for a store that lives on its Durable Object. The Store row is read through the
 * store's backend and the daily metric is written to the store's DO (analytics moved): Postgres THROWS if either job reaches it,
 * the guard lets both run, and a double fire upserts the same (store, date) row once.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const DO_STORE = '09b5dbd1-1774-49b5-b781-e06d0ee7b0fe';
const h = vi.hoisted(() => ({
  metrics: new Map<string, Record<string, unknown>>(),
  directory: [] as Array<Record<string, unknown>>,
}));
const doStore = {
  store: { findUnique: async () => ({ domain: 'dahab.example', plan: 'growth' }) },
};
vi.mock('@api/lib/repo-factory', () => ({
  storeRepo: async () => ({ backend: 'do', db: doStore }),
  storeDb: async () => doStore,
  storeWriter: async () => {
    throw new Error('writer not expected here');
  },
  storeMoney: async () => {
    throw new Error('DO money touched');
  },
}));
// analytics moved to the DO (marker present): the metric is written through the DO writer, never prisma
vi.mock('@api/lib/analytics-backend', () => ({
  analyticsWrite: async (
    _id: string,
    onDo: (w: unknown) => Promise<unknown>,
    _pg: () => Promise<unknown>
  ) =>
    onDo({
      gscDailyMetric: {
        upsert: async (a: {
          where: { storeId_date: { storeId: string; date: Date } };
          create: Record<string, unknown>;
        }) => {
          h.metrics.set(
            `${a.where.storeId_date.storeId}|${a.where.storeId_date.date.toISOString()}`,
            a.create
          );
          return a.create;
        },
      },
    }),
}));
vi.mock('@ebda/database', async () =>
  (await import('./helpers/database-mock')).databaseMock({
    prisma: new Proxy(
      {},
      {
        get: (_t, p) => {
          throw new Error(`Postgres touched: prisma.${String(p)}`);
        },
      }
    ),
    extra: {
      runInTenantContext: async () => {
        throw new Error('Postgres tenant transaction opened for a DO store');
      },
      withStore: async () => {
        throw new Error('Postgres withStore touched for a DO store');
      },
      withoutHiddenStores: (fn: () => unknown) => fn(),
      storeDirectory: async (pred: (s: Record<string, unknown>) => boolean) =>
        h.directory.filter(pred),
    },
  })
);
vi.mock('@api/lib/inngest/client', () => ({
  inngest: { createFunction: (options: unknown, handler: unknown) => ({ options, handler }) },
}));
vi.mock('@api/lib/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('@api/services/feature.service', () => ({
  featureService: { isFeatureEnabled: async () => true },
}));
vi.mock('@api/services/answer-engine/gsc-client', () => ({
  isGscConfigured: () => true,
  resolveGscTarget: async (d: string) => ({ siteUrl: `sc-domain:${d}` }),
  listAccessibleGscSites: async () => ['sc-domain:dahab.example'],
  pickGscTarget: (h: string, sites: string[]) =>
    sites.includes(`sc-domain:${h}`) ? { siteUrl: `sc-domain:${h}` } : null,
  mintGscWriteToken: async () => 'unused',
  resetGscSitesCache: () => {},
  querySearchAnalytics: async () => ({
    dateRows: [{ date: '2026-10-29', impressions: 10, clicks: 2, ctr: 0.2, position: 3 }],
    topQueries: [],
  }),
  GscNoAccessError: class extends Error {},
}));

import { gscIngestCron, gscIngestOnDemand } from '@api/lib/inngest/functions/gsc-ingest';
import { PORTED_JOBS } from '@api/lib/jobs/job-data';
import { decideRunForStore } from '@api/lib/jobs/do-guard';

type Handler = { handler: (a: unknown) => Promise<unknown> };
const step = {
  run: async <T>(_id: string, fn: () => Promise<T>): Promise<T> =>
    JSON.parse(JSON.stringify(await fn())),
};

beforeEach(() => {
  h.metrics.clear();
  h.directory = [
    { id: DO_STORE, status: 'active', hasDomain: true, aiFeaturesEnabled: true, plan: 'growth' },
  ];
  vi.stubEnv('JOBS_ON_DO', '1');
  vi.stubEnv('STORE_DO_ENABLED_IDS', DO_STORE);
});

describe('gsc ingest for a DO store', () => {
  it.each(['gsc-ingest-cron', 'gsc-ingest-on-demand'])(
    '%s is a ported job and runs for a DO store',
    async id => {
      expect(PORTED_JOBS.has(id)).toBe(true);
      expect(await decideRunForStore({ id } as never, DO_STORE)).toEqual({ run: true });
    }
  );

  it('on-demand ingests the store and a double fire upserts one (store, date) row', async () => {
    const event = { name: 'gsc/ingest-requested', data: { storeId: DO_STORE } };
    const run = () => (gscIngestOnDemand as unknown as Handler).handler({ event, step });
    await run();
    await run();
    expect(h.metrics.size).toBe(1);
    expect([...h.metrics.values()][0]).toMatchObject({
      storeId: DO_STORE,
      impressions: 10,
      clicks: 2,
    });
  });

  it('the daily cron lists the DO store like any other and double fire still writes one row', async () => {
    const event = { name: 'cron', data: {} };
    const run = () => (gscIngestCron as unknown as Handler).handler({ event, step });
    expect(await run()).toMatchObject({ configured: true, stores: 1, ingested: 1 });
    await run();
    expect(h.metrics.size).toBe(1);
  });
});
