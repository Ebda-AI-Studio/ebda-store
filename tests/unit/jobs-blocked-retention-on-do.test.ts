/**
 * Ruling CF-JOBS-4B: the four data-retention jobs for a store on its Durable Object. Orders and InstaPay receipts are swept on the
 * store's own alarm through DO ops (Postgres THROWS if reached); the search log (analytics table) and the soft-deleted-user
 * sweep (identity rows) open no store table and run for every store. Writers are delivered twice and write once.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const DO_STORE = '09b5dbd1-1774-49b5-b781-e06d0ee7b0fe';
const h = vi.hoisted(() => ({
  oldOrders: 3,
  anonCalls: [] as Array<{ cutoffMs: number; limit: number }>,
  receiptScrub: 2,
  sweepCalls: 0,
  purged: [] as string[],
  erased: [] as string[],
  users: [{ id: 'u1' }],
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
    defaultStoreIds: ['09b5dbd1-1774-49b5-b781-e06d0ee7b0fe'],
    prisma: {
      ...(h.boom('prisma') as object),
      user: { findMany: async () => h.users },
      // the cron's Postgres loop visits one (stand-in) store with nothing to sweep
      instapayReceipt: { findMany: async () => [], updateMany: async () => ({ count: 0 }) },
    },
    extra: {
      Prisma: { JsonNull: null, DbNull: null, sql: () => ({}), join: () => ({}) },
      storeDirectory: async () => [{ id: DO_STORE }],
      withStore: async () => {
        throw new Error('Postgres touched: withStore');
      },
    },
  })
);
vi.mock('@api/lib/repo-factory', () => {
  const money = {
    orderAnonymize: async (a: { cutoffMs: number; limit: number }) => {
      h.anonCalls.push(a);
      const n = h.oldOrders;
      h.oldOrders = 0; // the marker makes a scrubbed order stop matching
      return { anonymized: n };
    },
    receiptSweep: async () => {
      h.sweepCalls++;
      const n = h.receiptScrub;
      h.receiptScrub = 0;
      return { scrubbed: n, dueImages: [] };
    },
  };
  return {
    storeRepo: async () => ({
      backend: 'do',
      db: h.boom('do.db'),
      writer: h.boom('do.writer'),
      money,
    }),
    storeMoney: async () => money,
    storeDb: async () => h.boom('storeDb'),
  };
});
vi.mock('@api/lib/inngest/client', () => ({
  inngest: { createFunction: (options: unknown, handler: unknown) => ({ options, handler }) },
}));
vi.mock('@api/lib/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('@api/middleware/security', () => ({ auditLog: vi.fn(async () => undefined) }));
vi.mock('@api/services/auth.service', () => ({
  AuthService: { eraseAccount: async (id: string) => (h.erased.push(id), { crm: false }) },
  eraseNeedsCrmReview: () => false,
}));
vi.mock('@api/services/search-log.service', () => ({
  SEARCH_LOG_RETENTION_DAYS: 90,
  purgeSearchLogAcrossStores: async () => (h.purged.push(DO_STORE), { purged: 5, failedStores: 0 }),
}));
vi.mock('@api/services/storage.service', () => ({ StorageService: {} }));
vi.mock('@api/lib/ai/instapay-receipt-reader', () => ({ readInstapayReceipt: vi.fn() }));

import {
  instapayReceiptRetention,
  orderAnonymizeAtFiveYears,
  searchLogPurge,
  softDeletedUserAnonymize,
} from '@api/lib/inngest/functions/data-retention';
import { InstapayReceiptService } from '@api/services/payment-providers/instapay-receipt.service';
import { NO_STORE_DATA_JOBS, PORTED_JOBS } from '@api/lib/jobs/job-data';
import { ALARM_READY } from '@api/lib/jobs/alarm-flag';
import { decideRunForStore } from '@api/lib/jobs/do-guard';

type Handler = { handler: (a: unknown) => Promise<unknown> };
const step = {
  run: async <T>(_id: string, fn: () => Promise<T>): Promise<T> => {
    const v = await fn();
    return v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T);
  },
};
const alarm = { name: 'x', data: { alarm: true, storeId: DO_STORE } };
const call = (job: unknown, event: object) => (job as Handler).handler({ event, step });

beforeEach(() => {
  h.oldOrders = 3;
  h.receiptScrub = 2;
  h.anonCalls.length = 0;
  h.sweepCalls = 0;
  h.purged.length = 0;
  h.erased.length = 0;
  vi.stubEnv('JOBS_ON_DO', '1');
  vi.stubEnv('STORE_DO_ENABLED_IDS', DO_STORE);
});

describe('classification', () => {
  it.each(['instapay-receipt-retention-daily', 'order-anonymize-5y-monthly'])(
    '%s is ported and alarm-armed',
    id => {
      expect(PORTED_JOBS.has(id)).toBe(true);
      expect(ALARM_READY.has(id)).toBe(true);
      expect(decideRunForStore({ id } as never, DO_STORE)).toEqual({ run: true });
    }
  );
  it.each(['search-log-purge-daily', 'soft-deleted-user-anonymize-monthly'])(
    '%s opens no store table',
    id => {
      expect(NO_STORE_DATA_JOBS.has(id)).toBe(true);
      expect(decideRunForStore({ id } as never, DO_STORE)).toEqual({ run: true });
    }
  );
});

describe('order-anonymize-5y-monthly on a DO store', () => {
  it('scrubs through the DO op with a five-year cutoff; the second delivery scrubs nothing', async () => {
    const first = (await call(orderAnonymizeAtFiveYears, alarm)) as { anonymized: number };
    const second = (await call(orderAnonymizeAtFiveYears, alarm)) as { anonymized: number };
    expect(first.anonymized).toBe(3);
    expect(second.anonymized).toBe(0);
    const fiveYears = 365 * 5 * 24 * 3600 * 1000;
    expect(Math.abs(Date.now() - fiveYears - h.anonCalls[0].cutoffMs)).toBeLessThan(5000);
    expect(h.anonCalls[0].limit).toBe(500);
  });
});

describe('instapay-receipt-retention-daily on a DO store', () => {
  it('sweeps the named store through its DO and never lists Postgres stores; double fire scrubs once', async () => {
    const first = (await call(instapayReceiptRetention, alarm)) as { scrubbed: number };
    const second = (await call(instapayReceiptRetention, alarm)) as { scrubbed: number };
    expect(first.scrubbed).toBe(2);
    expect(second.scrubbed).toBe(0);
    expect(h.sweepCalls).toBe(2);
  });

  it('a cron run with jobs on the DO leaves DO stores to their alarms', async () => {
    const out = await InstapayReceiptService.sweepRetention(new Date(), undefined).catch(
      (e: Error) => e
    );
    // the Postgres loop is the mocked `acrossStores` over no rows; the DO store is NOT swept from the cron
    expect(h.sweepCalls).toBe(0);
    expect(out).not.toBeInstanceOf(Error);
  });
});

describe('search-log-purge-daily and soft-deleted-user-anonymize-monthly', () => {
  it('the search-log purge runs once per fire on analytics rows', async () => {
    expect(await call(searchLogPurge, { name: 'cron' })).toEqual({ purged: 5 });
    expect(h.purged).toHaveLength(1);
  });

  it('the user sweep erases each candidate through the account erasure (which scrubs the DO half itself)', async () => {
    const out = (await call(softDeletedUserAnonymize, { name: 'cron' })) as { anonymized: number };
    expect(out.anonymized).toBe(1);
    expect(h.erased).toEqual(['u1']);
  });
});
