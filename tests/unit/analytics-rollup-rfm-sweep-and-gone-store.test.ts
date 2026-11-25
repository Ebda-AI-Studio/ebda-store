/**
 * Rollup follow-ups to M-048: (1) the RFM stale sweep must run for a store with ZERO paid orders and must not send every
 * customer key as one `notIn` / `in` parameter list; (2) the on-demand run skips a gone store instead of retrying.
 * Mutation-proof: restoring the early `return 0` before the sweep, or the one-shot `notIn`, reddens (1); dropping the
 * `store-live` step reddens (2).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  snapshots: [] as Array<{ id: string; customerId: string; segment: string }>,
  orders: [] as unknown[],
  deletes: [] as Array<{ ids: number; whereKeys: string[] }>,
  handlers: [] as Array<(a: unknown) => Promise<unknown>>,
  repoError: null as unknown,
}));

vi.mock('@api/lib/customer-groups-store', async () => {
  const { CustomerGroups } = await import('@api/lib/customer-groups');
  return { loadCustomerGroups: async () => new CustomerGroups([]) };
});
vi.mock('@api/lib/savepoint', () => ({ withSavepoint: async <T>(fn: () => Promise<T>) => fn() }));
vi.mock('@ebda/database', () => ({
  prisma: {},
  RfmSegment: {
    lost: 'lost',
    vip: 'vip',
    loyal: 'loyal',
    new_customer: 'new_customer',
    potential: 'potential',
    at_risk: 'at_risk',
    hibernating: 'hibernating',
  },
  withRlsBypass: vi.fn(),
  storeDirectory: vi.fn(),
}));
vi.mock('@api/lib/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('@api/lib/inngest/client', () => ({
  inngest: {
    createFunction: vi.fn((_cfg: unknown, handler: (a: unknown) => Promise<unknown>) => {
      h.handlers.push(handler);
      return {};
    }),
  },
}));
vi.mock('@api/lib/jobs/store-db', () => ({
  runInStoreCtx: async (_s: string, fn: () => unknown) => fn(),
}));
vi.mock('@api/lib/jobs/store-scope', () => ({ storeFilter: vi.fn() }));
vi.mock('@api/lib/repo-factory', () => ({
  storeRepo: async () => {
    if (h.repoError) throw h.repoError;
    return {};
  },
  storeDb: async () => ({
    order: { findMany: async () => h.orders },
    customerRfmSnapshot: {
      findMany: async (a: { take: number; cursor?: { id: string } }) => {
        const start = a.cursor ? h.snapshots.findIndex(s => s.id === a.cursor!.id) + 1 : 0;
        return h.snapshots.slice(start, start + a.take);
      },
    },
  }),
  storeWriter: async () => ({
    customerRfmSnapshot: {
      deleteMany: async (a: { where: { id?: { in: string[] }; customerId?: unknown } }) => {
        const ids = a.where.id?.in ?? [];
        h.deletes.push({ ids: ids.length, whereKeys: Object.keys(a.where) });
        h.snapshots = h.snapshots.filter(s => !ids.includes(s.id));
        return { count: ids.length };
      },
      createMany: async () => ({ count: 0 }),
      update: async () => ({}),
    },
  }),
}));

import { runRfmRollup } from '@api/services/accounting/analytics-rollup.service';
import { AppError } from '@api/middleware/error-handler';
import '@api/lib/inngest/functions/analytics-daily-rollup';

beforeEach(() => {
  h.snapshots = [];
  h.orders = [];
  h.deletes = [];
  h.repoError = null;
});

describe('RFM stale sweep', () => {
  it('empties the segments of a store whose last paid order is gone', async () => {
    h.snapshots = Array.from({ length: 250 }, (_, i) => ({
      id: `s${String(i).padStart(4, '0')}`,
      customerId: `c${i}`,
      segment: 'vip',
    }));
    expect(await runRfmRollup('store-1')).toBe(0);
    expect(h.snapshots).toHaveLength(0);
  });

  it('deletes by id in bounded chunks, never one unbounded customer-key list', async () => {
    h.snapshots = Array.from({ length: 250 }, (_, i) => ({
      id: `s${String(i).padStart(4, '0')}`,
      customerId: `c${i}`,
      segment: 'vip',
    }));
    await runRfmRollup('store-1');
    expect(h.deletes.map(d => d.ids)).toEqual([100, 100, 50]);
    for (const d of h.deletes) expect(d.whereKeys).not.toContain('customerId');
  });
});

describe('analytics-rollup-on-demand gone store', () => {
  const onDemand = () => h.handlers[1]!;
  const step = { run: async (_id: string, fn: () => Promise<unknown>) => fn() };

  it('skips a store whose storage is gone (410/404) instead of throwing', async () => {
    h.repoError = new AppError(410, 'STORE_STORAGE_REMOVED', 'gone');
    await expect(
      onDemand()({ event: { id: 'e1', data: { storeId: 's1' } }, step })
    ).resolves.toEqual({ skipped: 'store-gone' });
  });

  it('still throws on an unreadable directory (503) so it retries', async () => {
    h.repoError = new AppError(503, 'STORE_DIRECTORY_UNAVAILABLE', 'down');
    await expect(
      onDemand()({ event: { id: 'e1', data: { storeId: 's1' } }, step })
    ).rejects.toThrow();
  });
});
