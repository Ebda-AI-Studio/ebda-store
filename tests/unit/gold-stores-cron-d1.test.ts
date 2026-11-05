/**
 * Ruling NZ-PG-2: the two gold-rate crons with the platform D1 bound. The cron run (no alarm store) lists the stores from the D1
 * directory and reads each one's DO; the Postgres definers (`ebda_gold_feed_stores`, `ebda_gold_rate_watch`) are never called.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const h = vi.hoisted(() => ({
  d1: true,
  dirFilterSeen: [] as string[],
  settings: {} as Record<string, Record<string, unknown> | null>,
  current: {} as Record<string, Array<Record<string, unknown>>>,
  activeIds: new Set<string>(),
}));
vi.mock('@api/lib/definer', () => ({
  goldFeedStores: async () => {
    throw new Error('Postgres touched: ebda_gold_feed_stores');
  },
  goldRateWatch: async () => {
    throw new Error('Postgres touched: ebda_gold_rate_watch');
  },
}));
vi.mock('@api/lib/platform-directory', () => ({ platformDb: () => (h.d1 ? {} : undefined) }));
vi.mock('@ebda/database', async () =>
  (await import('./helpers/database-mock')).databaseMock({
    extra: {
      storeDirectory: async (filter?: (s: { status: string }) => boolean) =>
        [A, B].map(id => ({ id, status: 'active' })).filter(s => (filter ? filter(s) : true)),
      dropHiddenStores: <T>(x: T[]) => x,
      withStore: async (_id: string, fn: (tx: unknown) => unknown) =>
        fn({ store: { findUnique: async () => ({ status: 'active', deletedAt: null }) } }),
    },
  })
);
vi.mock('@api/lib/jobs/store-db', () => ({
  withStoreDb: async (id: string, fn: (db: unknown) => unknown) =>
    fn({
      store: {
        findUnique: async () =>
          h.activeIds.has(id)
            ? { status: 'active', deletedAt: null }
            : { status: 'inactive', deletedAt: null },
      },
    }),
}));
vi.mock('@api/lib/repo-factory', () => ({
  storeRepo: async (id: string) => ({
    backend: 'do',
    db: {
      goldRateSettings: { findUnique: async () => h.settings[id] ?? null },
      goldRateCurrent: { findMany: async () => h.current[id] ?? [] },
      product: { findFirst: async () => ({ id: 'p' }) },
    },
  }),
}));

import { goldFeedStoresFor, goldRateWatchFor } from '@api/lib/jobs/gold-stores';

beforeEach(() => {
  h.d1 = true;
  h.settings = {};
  h.current = {};
  h.activeIds = new Set([A, B]);
});

describe('gold crons on D1 (no Postgres)', () => {
  it('the feed cron returns the opted-in DO stores and never calls the definer', async () => {
    h.settings = {
      [A]: { enabled: true, feedEnabled: true, feedPremiumBps: 150 },
      [B]: { enabled: true, feedEnabled: false, feedPremiumBps: 0 },
    };
    expect(await goldFeedStoresFor(undefined)).toEqual([{ storeId: A, premiumBps: 150 }]);
  });

  it('an inactive store is not fed', async () => {
    h.settings = { [A]: { enabled: true, feedEnabled: true, feedPremiumBps: 1 } };
    h.activeIds = new Set([B]);
    expect(await goldFeedStoresFor(undefined)).toEqual([]);
  });

  it('the staleness watch returns the old (store, karat) pairs of every DO store', async () => {
    const old = new Date(Date.now() - 30 * 3_600_000);
    h.settings = { [A]: { maxAgeMinutes: 600 } };
    h.current = {
      [A]: [{ karat: 21, rateId: 'r1', appliedAt: old }],
      [B]: [{ karat: 18, rateId: 'r2', appliedAt: old }],
    };
    const out = await goldRateWatchFor(undefined);
    expect(out.map(r => [r.storeId, r.karat, r.maxAgeMinutes])).toEqual([
      [A, 21, 600],
      [B, 18, 1560],
    ]);
  });

  it('without a D1 binding the definer path is unchanged (Node / local dev)', async () => {
    h.d1 = false;
    await expect(goldFeedStoresFor(undefined)).rejects.toThrow('Postgres touched');
    await expect(goldRateWatchFor(undefined)).rejects.toThrow('Postgres touched');
  });
});
