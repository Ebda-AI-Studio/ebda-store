/**
 * 2026-11-09 P1: `search-log-purge-daily` and `webhook-delivery-purge-daily` each failed "1 store(s)" every day. The one store is
 * the soft-deleted `qa-merchant-test`, still `storage_backend = 'pg'` in the D1 directory; both jobs sweep EVERY store including
 * deleted ones, and on the Postgres-less Worker its first query raised POSTGRES_REMOVED. A store with no reachable data is
 * skipped, never a failure; a DO store is still purged.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const PG = 'pg-store';
const DO = 'do-store';
const removed = { v: true };

vi.mock('../../apps/api/src/lib/postgres-present', () => ({
  postgresRemovedOnThisWorker: () => removed.v,
}));
vi.mock('../../apps/api/src/lib/store-backend', () => ({
  backendFor: async (id: string) => (id === DO ? 'do' : 'pg'),
}));
const purgeOp = vi.fn(async () => ({ deleted: 3 }));
const executeRaw = vi.fn(async () => {
  throw new Error('POSTGRES_REMOVED');
});
vi.mock('../../apps/api/src/lib/analytics-backend', () => ({
  analyticsMoney: async (id: string) => (id === DO ? { searchLogPurge: purgeOp } : null),
}));
vi.mock('../../apps/api/src/lib/jobs/store-db', () => ({
  runInStoreCtx: async (_id: string, fn: () => Promise<unknown>) => fn(),
}));
vi.mock('@ebda/database', async () => ({
  ...(await import('./helpers/database-mock')).databaseMock({}),
  withStore: async (_id: string, fn: (tx: unknown) => unknown) => fn({ $executeRaw: executeRaw }),
  storeDirectory: async () => [{ id: PG }, { id: DO }],
  withoutHiddenStores: (fn: () => unknown) => fn(),
}));
vi.mock('../../apps/api/src/lib/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { purgeSearchLogAcrossStores } from '../../apps/api/src/services/search-log.service';
import { storeHasNoDataHere } from '../../apps/api/src/lib/store-pg-gone';

describe('stores with no reachable data are skipped by retention sweeps', () => {
  beforeEach(() => {
    removed.v = true;
    executeRaw.mockClear();
  });

  it('storeHasNoDataHere: pg store on a Postgres-less Worker only', async () => {
    expect(await storeHasNoDataHere(PG)).toBe(true);
    expect(await storeHasNoDataHere(DO)).toBe(false);
    removed.v = false; // Node / Railway keeps Postgres
    expect(await storeHasNoDataHere(PG)).toBe(false);
  });

  it('search-log purge: the pg store is skipped (not failed), the DO store is purged', async () => {
    const r = await purgeSearchLogAcrossStores();
    expect(r).toEqual({ purged: 3, failedStores: 0 });
    expect(executeRaw).not.toHaveBeenCalled();
  });
});
