/**
 * N-18 review item 2: on the D1 + DO path the owner row is created in a Postgres transaction that stays open until the store exists.
 * A failed create rolls the owner back (a retry is a fresh account that receives its temporary password); a failed COMMIT after the
 * store exists rolls the store back.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  users: new Set<string>(),
  failInsert: false,
  failCommit: false,
  rolledBack: [] as string[],
  inserted: [] as string[],
}));

vi.mock('@ebda/database', () => ({
  prisma: {},
  Prisma: {},
  StoreStatus: {},
  acrossStores: vi.fn(),
  scopeTransaction: vi.fn(),
  withStore: vi.fn(),
  // a transaction: staged users commit only if the callback and the commit succeed
  withMoneyTx: async (_p: unknown, fn: (tx: unknown) => Promise<unknown>) => {
    const staged = new Set<string>();
    const out = await fn({ staged });
    if (h.failCommit) throw new Error('commit failed');
    for (const u of staged) h.users.add(u);
    return out;
  },
}));
vi.mock('../../apps/api/src/lib/definer', () => ({
  storeIdBySlug: async () => null,
  storeIdByDomain: async () => null,
  ensureAdminUser: async (i: { email: string }, tx: { staged: Set<string> }) => {
    const created = !h.users.has(i.email);
    if (created) tx.staged.add(i.email);
    return { id: `u-${i.email}`, created, email: i.email, role: 'store_admin', status: 'active' };
  },
}));
vi.mock('../../apps/api/src/lib/store-create-do', () => ({
  storeCreateOnDo: () => true,
  insertDoStore: async () => {
    if (h.failInsert) throw new Error('d1 down');
    h.inserted.push('s1');
    return 's1';
  },
  finishDoStoreCreate: async () => ({ id: 's1', name: 'N', slug: 'n', domain: null }),
  rollbackDoStore: async (id: string) => void h.rolledBack.push(id),
}));
vi.mock('../../apps/api/src/lib/repo-factory', () => ({
  storeDb: vi.fn(),
  storeUpdate: vi.fn(),
  storeWriter: vi.fn(),
}));
vi.mock('../../apps/api/src/services/store.service', () => ({ bustStoreCaches: vi.fn() }));
vi.mock('../../apps/api/src/lib/store-directory-sync', () => ({
  syncStoreDirectoryFromPg: vi.fn(),
}));
vi.mock('../../apps/api/src/services/email.service', () => ({
  EmailService: { sendWelcome: vi.fn(async () => undefined) },
}));
vi.mock('../../apps/api/src/services/domain-provider', () => ({ resolveDomainService: vi.fn() }));
vi.mock('../../apps/api/src/lib/inngest/client', () => ({
  inngest: { send: vi.fn(async () => undefined) },
}));

import { ProvisioningService } from '../../apps/api/src/services/provisioning.service';

const run = () =>
  ProvisioningService.provisionStore({
    storeName: 'Nour',
    storeSlug: 'nour-shop',
    ownerEmail: 'o@x.com',
    ownerName: 'Owner',
  });

beforeEach(() => {
  h.users.clear();
  h.failInsert = false;
  h.failCommit = false;
  h.rolledBack.length = 0;
  h.inserted.length = 0;
});

describe('provisionStore on D1 + DO: owner and store succeed or fail together', () => {
  it('a failed create leaves NO owner row; the retry is a new account and gets its temporary password', async () => {
    h.failInsert = true;
    await expect(run()).rejects.toThrow('d1 down');
    expect(h.users.size).toBe(0);
    h.failInsert = false;
    const retry = await run();
    expect(retry.owner.temporaryPassword).toBeTruthy();
  });
  it('a failed commit after the store exists rolls the store back and leaves no owner', async () => {
    h.failCommit = true;
    await expect(run()).rejects.toThrow('commit failed');
    expect(h.rolledBack).toEqual(['s1']);
    expect(h.users.size).toBe(0);
  });
});
