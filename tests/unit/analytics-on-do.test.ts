/**
 * Ruling NZ-AN-1: per-store analytics follow the store's backend. A DO store whose analytics moved (D1 marker
 * `platform_cutover.analytics`) is served ONLY by its DO - Postgres THROWS if touched; before the marker, or while the copy
 * freezes writes, nothing changes / writes are refused with a retryable 503 and reads still answer from Postgres.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const STORE = '09b5dbd1-1774-49b5-b781-e06d0ee7b0fe';
const h = vi.hoisted(() => {
  const state = {
    doBacked: true,
    marker: true,
    frozen: false,
    calls: [] as Array<[string, unknown]>,
  };
  const poison = (what: string) =>
    new Proxy(
      {},
      {
        get: (_t, p) => {
          throw new Error(`Postgres touched: ${what}.${String(p)}`);
        },
      }
    );
  const money = new Proxy(
    {},
    {
      get: (_t, op: string) =>
        op === 'then'
          ? undefined
          : async (a: unknown) => {
              state.calls.push([op, a]);
              if (op === 'searchInsights')
                return {
                  totals: { searches: 10, zero: 4 },
                  terms: [{ term: 'a', searches: 10, zero_results: 4, last_result_count: 2 }],
                };
              if (op === 'searchLogPurge') return { deleted: 3 };
              return { counted: true };
            },
    }
  );
  return Object.assign(state, { poison, money });
});
vi.mock('@ebda/database', async () =>
  (await import('./helpers/database-mock')).databaseMock({
    prisma: h.poison('prisma'),
    extra: {
      withStore: async () => {
        throw new Error('Postgres touched: withStore');
      },
      withoutHiddenStores: (fn: () => unknown) => fn(),
      storeDirectory: async () => [{ id: STORE }],
    },
  })
);
vi.mock('@api/lib/repo-factory', () => ({
  storeWritesToDo: async () => h.doBacked,
  storeMoney: async () => h.money,
  storeDb: async () => ({
    qrScanDaily: {
      groupBy: async () => {
        h.calls.push(['qrGroupBy', null]);
        return [];
      },
    },
  }),
  storeWriter: async () => h.poison('writer'),
  storeRepo: async () => ({ backend: h.doBacked ? 'do' : 'pg', db: h.poison('db') }),
}));
vi.mock('@api/services/platform/cutover', () => ({
  platformFamilyOnD1: async () => h.marker,
  platformFamilyOnD1ForWrite: async () => {
    if (h.frozen && !h.marker) throw Object.assign(new Error('frozen'), { statusCode: 503 });
    return h.marker;
  },
}));
vi.mock('@api/lib/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('@api/services/redis.service', () => ({
  redis: { getClient: () => null, isAvailable: () => false },
}));
vi.mock('@api/lib/jobs/store-db', () => ({
  runInStoreCtx: async (_id: string, fn: () => Promise<unknown>) => fn(),
}));

import { analyticsOnDo } from '@api/lib/analytics-backend';
import {
  getSearchInsights,
  purgeSearchLogAcrossStores,
  recordSearch,
} from '@api/services/search-log.service';
import { recordProductView } from '@api/services/view-ingest.service';
import { qrStats, recordQrScan } from '@api/services/qr.service';

beforeEach(() => {
  h.doBacked = true;
  h.marker = true;
  h.frozen = false;
  h.calls.length = 0;
  vi.stubEnv('SEARCH_LOG_SECRET', 'x');
});

describe('analyticsOnDo', () => {
  it('is true only for a DO store AFTER the marker', async () => {
    expect(await analyticsOnDo(STORE, 'write')).toBe(true);
    h.marker = false;
    expect(await analyticsOnDo(STORE, 'write')).toBe(false);
    h.marker = true;
    h.doBacked = false;
    expect(await analyticsOnDo(STORE, 'read')).toBe(false);
  });

  it('a frozen copy refuses writes (retryable) but a read still goes to Postgres', async () => {
    h.marker = false;
    h.frozen = true;
    await expect(analyticsOnDo(STORE, 'write')).rejects.toThrow('frozen');
    expect(await analyticsOnDo(STORE, 'read')).toBe(false);
  });
});

describe('counters and reads on a DO store with the marker', () => {
  it('recordSearch writes the DO counter', async () => {
    expect(await recordSearch(STORE, 'wireless charger', 0)).toBe(true);
    expect(h.calls[0][0]).toBe('searchLogRecord');
    expect(h.calls[0][1]).toMatchObject({ term: 'wireless charger', count: 0, zero: 1 });
    expect((h.calls[0][1] as { dayMs: number }).dayMs % 86_400_000).toBe(0);
  });

  it('getSearchInsights and the purge read the DO', async () => {
    const r = await getSearchInsights(STORE, { days: 7, filter: 'all' });
    expect(r.totals).toEqual({ searches: 10, zeroResultSearches: 4, zeroResultRate: 0.4 });
    expect(r.terms[0]).toMatchObject({ term: 'a', zeroResults: 4 });
    expect(await purgeSearchLogAcrossStores({ storeIds: [STORE] })).toEqual({
      purged: 3,
      failedStores: 0,
    });
  });

  it('product views and QR scans count in the DO; qrStats reads its group-by', async () => {
    expect(await recordProductView(STORE, 'p1')).toBe(true);
    expect(await recordQrScan(STORE, 'product', 'p1')).toBe(true);
    expect(await qrStats(STORE, 7)).toEqual([]);
    expect(h.calls.map(c => c[0])).toEqual(['viewRecord', 'qrScanRecord', 'qrGroupBy']);
  });

  it('a counter fails open: a frozen copy is swallowed, nothing is counted', async () => {
    h.marker = false;
    h.frozen = true;
    expect(await recordSearch(STORE, 'wireless charger', 1)).toBe(false);
    expect(await recordProductView(STORE, 'p2')).toBe(false);
  });
});
