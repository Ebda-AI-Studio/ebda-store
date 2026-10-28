/**
 * Deleting a store whose owner owns nothing else deletes the owner's profile row too. The owner's identity must be ended
 * with it (Rulings ID-2/ID-9): deactivated BEFORE the delete, re-activated if the transaction rolls back (never
 * un-suspending an owner who was already suspended), and erased only after the commit.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  order: [] as string[],
  managed: true,
  accountStatus: 'active' as 'active' | 'suspended',
  failTx: false,
  ownerStores: 0,
}));

vi.mock('@ebda/database', () => {
  const tx: any = new Proxy(
    {
      $executeRaw: async () => 0,
      $queryRaw: async () => [],
      user: {
        findUnique: async () => ({
          id: 'owner-1',
          role: 'store_admin',
          _count: { stores: h.ownerStores },
        }),
        delete: async () => {
          h.order.push('pg-delete-owner');
          if (h.failTx) throw new Error('commit failed');
        },
      },
    },
    { get: (t: any, k: string) => t[k] }
  );
  return {
    prisma: {},
    Prisma: {},
    StoreStatus: {},
    withStore: vi.fn(),
    // the billing-parent guard's sibling-store lookup: the owner has no other stores
    withUser: async () => [],
    acrossStores: vi.fn(),
    withMoneyTx: async (_p: unknown, fn: (t: unknown) => unknown) => fn(tx),
    scopeTransaction: async (_t: unknown, _c: unknown, fn: () => unknown) => fn(),
    asPlatformOperator: async (_id: string, fn: () => unknown) => fn(),
  };
});
vi.mock('@api/lib/definer', () => ({
  deleteUserTokens: async () => {},
  detachStoreAuditLogs: async () => 0,
  unlinkUserAuditLogs: async () => {},
  lookupStore: vi.fn(),
  storeIdByDomain: vi.fn(),
  storeIdBySlug: vi.fn(),
}));
vi.mock('@api/lib/identity-client', () => ({
  isIdentityManagedUser: async () => h.managed,
  getAccountState: async () => ({ status: h.accountStatus }),
  setAccountStatus: async (_id: string, status: string) => void h.order.push(`identity-${status}`),
  eraseIdentityUser: async () => void h.order.push('identity-erase'),
}));
vi.mock('@api/services/store-closure.service', () => ({
  assertNoMoneyInFlight: async () => {},
  archiveFiscalRecords: async () => {},
}));
vi.mock('@api/services/redis.service', () => ({ redis: { delete: async () => {} } }));
vi.mock('@api/lib/public-cache', () => ({
  invalidateCached: vi.fn(),
  invalidateCachedPrefix: vi.fn(),
  memoryCache: { get: vi.fn(), set: vi.fn() },
}));
vi.mock('@api/lib/logger', () => ({
  default: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('@api/services/r2-cleanup.service', () => ({
  cleanupRemovedImages: vi.fn(),
  deleteR2ObjectIfOrphan: vi.fn(),
}));
vi.mock('@api/services/accounting/account.service', () => ({ seedCoaForStore: vi.fn() }));

const { StoreService } = await import('@api/services/store.service');

beforeEach(() => {
  h.order = [];
  h.managed = true;
  h.accountStatus = 'active';
  h.failTx = false;
  h.ownerStores = 0;
  vi.spyOn(StoreService, 'getById').mockResolvedValue({
    id: 's1',
    ownerId: 'owner-1',
    slug: 's',
    domain: null,
  } as never);
});

describe('StoreService.delete and the owner identity', () => {
  it('deactivates the identity before the delete and erases it only after the commit', async () => {
    await StoreService.delete('s1', 'admin-1');
    expect(h.order).toEqual(['identity-inactive', 'pg-delete-owner', 'identity-erase']);
  });

  it('re-activates the identity when the transaction fails, and never erases it', async () => {
    h.failTx = true;
    await expect(StoreService.delete('s1', 'admin-1')).rejects.toThrow('commit failed');
    expect(h.order).toEqual(['identity-inactive', 'pg-delete-owner', 'identity-active']);
  });

  it('leaves an already-suspended owner suspended on rollback (only an active owner is flipped)', async () => {
    h.accountStatus = 'suspended';
    h.failTx = true;
    await expect(StoreService.delete('s1', 'admin-1')).rejects.toThrow();
    expect(h.order).toEqual(['pg-delete-owner']);
  });

  it('still erases the identity of a suspended owner whose row was deleted', async () => {
    h.accountStatus = 'suspended';
    await StoreService.delete('s1', 'admin-1');
    expect(h.order).toEqual(['pg-delete-owner', 'identity-erase']);
  });

  it('touches no identity when the owner still owns another store', async () => {
    h.ownerStores = 1;
    await StoreService.delete('s1', 'admin-1');
    expect(h.order).toEqual([]);
  });
});
