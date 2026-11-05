/**
 * Ruling NZ-PG-2: the impersonation target and the payment-event / product / journal owner lookups with Postgres gone.
 * An admin account is the identity service's; a customer is found through the D1 entity index and read from its store DO;
 * a primary-key probe of the DOs finds an id the index does not hold.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  account: null as null | Record<string, unknown>,
  cachedTv: null as number | null,
  customerStore: null as string | null,
  route: 'do' as 'do' | 'pg',
  row: null as null | Record<string, unknown>,
  state: null as null | { tokenVersion: number },
  dirStores: [] as Array<{ id: string; storageBackend: 'do' | 'pg' }>,
  holders: {} as Record<string, string>,
  probed: [] as string[],
}));
vi.mock('@api/lib/identity-client', () => ({ getAccountState: async () => h.account }));
vi.mock('@api/lib/definer', () => ({ getEntityStoreId: async () => h.customerStore }));
vi.mock('@api/lib/customer-auth', () => ({
  customerAuthRoute: async () =>
    h.route === 'do' ? { kind: 'do', client: { call: async () => h.state } } : { kind: 'pg' },
}));
vi.mock('@api/lib/customer-directory', () => ({ customerRow: async () => h.row }));
vi.mock('@api/services/redis.service', () => ({
  redis: { getUserTokenVersion: async () => h.cachedTv },
}));
vi.mock('@api/services/platform/directory-d1', () => ({
  listDirectoryStores: async () => h.dirStores,
}));
vi.mock('@api/lib/repo-factory', () => ({
  storeDb: async (storeId: string) => {
    const probe = (model: string) => ({
      findUnique: async ({ where }: { where: { id: string } }) => {
        h.probed.push(storeId);
        if (storeId === 'bad') throw new Error('DO down');
        return h.holders[`${model}:${where.id}`] === storeId ? { id: where.id } : null;
      },
    });
    return {
      product: probe('product'),
      journalEntry: probe('journal_entry'),
      bulkImportJob: probe('bulk_import_job'),
      paymentEvent: probe('payment_event'),
    };
  },
}));

import { impersonationTargetD1 } from '@api/lib/impersonation-target';
import { entityStoreByFanout } from '@api/lib/entity-store-fanout';

beforeEach(() => {
  h.account = null;
  h.cachedTv = null;
  h.customerStore = null;
  h.route = 'do';
  h.row = null;
  h.state = null;
  h.dirStores = [];
  h.holders = {};
  h.probed = [];
});

describe('impersonationTargetD1', () => {
  it('an admin-namespace account comes from the identity service (token version: the cached one)', async () => {
    h.account = { id: 'u1', email: 'm@x.co', role: 'store_admin', status: 'suspended' };
    h.cachedTv = 7;
    expect(await impersonationTargetD1('u1')).toEqual({
      id: 'u1',
      email: 'm@x.co',
      role: 'store_admin',
      storeId: null,
      deletedAt: null,
      tokenVersion: 7,
      status: 'suspended',
    });
  });

  it('a customer is found through the entity index and read from its store DO', async () => {
    h.customerStore = 'store-a';
    h.row = { id: 'c1', email: 'c@x.co', status: 'active', deletedAt: null };
    h.state = { tokenVersion: 3 };
    expect(await impersonationTargetD1('c1')).toEqual({
      id: 'c1',
      email: 'c@x.co',
      role: 'customer',
      storeId: 'store-a',
      deletedAt: null,
      tokenVersion: 3,
      status: 'active',
    });
  });

  it('unknown everywhere is null (a 404)', async () => {
    expect(await impersonationTargetD1('nobody')).toBeNull();
    h.customerStore = 'store-a';
    h.route = 'pg';
    expect(await impersonationTargetD1('c1')).toBeNull();
    h.route = 'do';
    h.row = null;
    h.state = null;
    expect(await impersonationTargetD1('c1')).toBeNull();
  });
});

describe('entityStoreByFanout', () => {
  it('finds the DO store that holds the id, probing only DO stores', async () => {
    h.dirStores = [
      { id: 'pg-1', storageBackend: 'pg' },
      { id: 'a', storageBackend: 'do' },
      { id: 'b', storageBackend: 'do' },
    ];
    h.holders = { 'payment_event:ev1': 'b', 'product:p1': 'a' };
    expect(await entityStoreByFanout('payment_event', 'ev1')).toBe('b');
    expect(await entityStoreByFanout('product', 'p1')).toBe('a');
    expect(h.probed).not.toContain('pg-1');
  });

  it('an unreadable store is skipped, an unclaimed id is null', async () => {
    h.dirStores = [
      { id: 'bad', storageBackend: 'do' },
      { id: 'a', storageBackend: 'do' },
    ];
    h.holders = { 'journal_entry:j1': 'a' };
    expect(await entityStoreByFanout('journal_entry', 'j1')).toBe('a');
    expect(await entityStoreByFanout('bulk_import_job', 'zzz')).toBeNull();
  });
});
