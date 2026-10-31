/**
 * Ruling CF-JOBS-4B: store-usage-snapshot for a store on its Durable Object. The catalogue and commerce counts come from the DO op
 * `usageCounts`, the analytics numbers and the snapshot row from the platform side; the store-scoped Postgres query THROWS if
 * reached. Double fire: the snapshot is upserted by (store, period), so one row.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const DO_STORE = '09b5dbd1-1774-49b5-b781-e06d0ee7b0fe';
const h = vi.hoisted(() => ({
  snapshots: new Map<string, Record<string, any>>(),
  usageArgs: [] as Array<{ startMs: number; endMs: number }>,
  deleted: false,
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
      withStore: async (_id: string, fn: (tx: unknown) => Promise<unknown>) =>
        fn({
          store: { findUnique: async () => ({ deletedAt: h.deleted ? new Date() : null }) },
          $queryRaw: async () => [
            {
              product_views: 40n,
              ai_calls: 3n,
              ai_billable_calls: 2n,
              ai_tokens_in: 100n,
              ai_tokens_out: 50n,
              ai_cost_micros: 900n,
              ai_unpriced_calls: 0n,
            },
          ],
          storeUsageSnapshot: {
            upsert: async (a: { where: any; create: Record<string, any> }) => {
              h.snapshots.set(
                `${a.create.storeId}|${a.create.periodStart.toISOString()}`,
                a.create
              );
            },
          },
        }),
    },
  })
);
vi.mock('@api/lib/repo-factory', () => ({
  storeRepo: async () => ({ backend: 'do' }),
  storeMoney: async () => ({
    usageCounts: async (a: { startMs: number; endMs: number }) => {
      h.usageArgs.push(a);
      return {
        products: 12,
        productsActive: 10,
        variants: 30,
        images: 40,
        categories: 4,
        orders: 7,
        revenueFils: 123456,
        customers: 5,
        sessionsProxy: 90,
        cartsWithItems: 11,
      };
    },
  }),
}));
vi.mock('@api/lib/inngest/client', () => ({
  inngest: { createFunction: (options: unknown, handler: unknown) => ({ options, handler }) },
}));
vi.mock('@api/lib/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
const alerts = vi.hoisted(() => ({ sendAlert: vi.fn(async () => 'sent') }));
vi.mock('@api/services/alerts.service', () => alerts);

import { storeUsageSnapshot } from '@api/lib/inngest/functions/store-usage-snapshot';
import { PORTED_JOBS } from '@api/lib/jobs/job-data';
import { ALARM_READY } from '@api/lib/jobs/alarm-flag';
import { decideRunForStore } from '@api/lib/jobs/do-guard';

const step = {
  run: async <T>(_id: string, fn: () => Promise<T>): Promise<T> => {
    const v = await fn();
    return v === undefined
      ? v
      : (JSON.parse(JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x))) as T);
  },
};
const event = { name: 'x', data: { alarm: true, storeId: DO_STORE, periodStart: '2026-09-01' } };
const run = () =>
  (storeUsageSnapshot as unknown as { handler: (a: unknown) => Promise<any> }).handler({
    event,
    step,
  });

beforeEach(() => {
  h.snapshots.clear();
  h.usageArgs.length = 0;
  h.deleted = false;
  alerts.sendAlert.mockClear();
  vi.stubEnv('JOBS_ON_DO', '1');
  vi.stubEnv('STORE_DO_ENABLED_IDS', DO_STORE);
});

describe('store-usage-snapshot on a DO store', () => {
  it('is ported, alarm-armed and not refused', async () => {
    expect(PORTED_JOBS.has('store-usage-snapshot')).toBe(true);
    expect(ALARM_READY.has('store-usage-snapshot')).toBe(true);
    expect(await decideRunForStore({ id: 'store-usage-snapshot' } as never, DO_STORE)).toEqual({
      run: true,
    });
  });

  it('writes the DO counts plus the analytics numbers; double fire leaves one row', async () => {
    expect(await run()).toEqual({ periodStart: '2026-09-01', stores: 1 });
    await run();
    expect(h.snapshots.size).toBe(1);
    expect([...h.snapshots.values()][0]).toMatchObject({
      storeId: DO_STORE,
      products: 12,
      orders: 7,
      revenueFils: 123456n,
      productViews: 40n,
      aiCalls: 3,
      aiCostMicros: 900n,
    });
    expect(h.usageArgs[0]).toEqual({
      startMs: Date.UTC(2026, 8, 1),
      endMs: Date.UTC(2026, 9, 1),
    });
  });

  it('a deleted store writes nothing and raises the empty-run alert', async () => {
    h.deleted = true;
    expect(await run()).toEqual({ periodStart: '2026-09-01', stores: 0 });
    expect(h.snapshots.size).toBe(0);
    expect(alerts.sendAlert).toHaveBeenCalledOnce();
  });
});
