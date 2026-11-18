/**
 * C1 of the #772 re-review: the OWNER's self-service deletion runs the REAL `StoreService.delete` with the owner as the actor.
 * `asPlatformOperator` (faithfully modelled below) throws for anyone who is not an active super_admin, so the old call
 * (`delete(storeId, ownerId)`) rolled the transaction back and the job died. The owner path must complete, and must NOT touch the
 * owner's account (account closure is a separate flow).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  order: [] as string[],
  managed: true,
  accountStatus: 'active' as 'active' | 'suspended',
  failTx: false,
  ownerStores: 0,
  clients: [] as string[],
  clientFailures: 0,
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
    asPlatformOperator: async (id: string, fn: () => unknown) => {
      if (id !== 'admin-1')
        throw new Error('asPlatformOperator: the acting user is not an active super_admin');
      return fn();
    },
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
  deleteStoreClients: async (id: string) => {
    if (h.clientFailures > 0) {
      h.clientFailures--;
      throw new Error('identity down');
    }
    h.clients.push(id);
    return { clients: 1 };
  },
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
  h.clients = [];
  h.clientFailures = 0;
  vi.spyOn(StoreService, 'getById').mockResolvedValue({
    id: 's1',
    ownerId: 'owner-1',
    slug: 's',
    domain: null,
  } as never);
});

describe('StoreService.delete as the store OWNER (self-service)', () => {
  it('the old call shape (owner passed as the plain actor) is refused by the platform-operator gate', async () => {
    await expect(StoreService.delete('s1', 'owner-1')).rejects.toThrow('not an active super_admin');
  });

  it('the owner-request path completes without a super_admin and leaves the owner account alone', async () => {
    await expect(
      StoreService.delete('s1', 'owner-1', { ownerRequest: { requestId: 'req-1' } })
    ).resolves.not.toThrow();
    // the owner's only store is gone, yet their profile / identity are neither deleted nor deactivated nor erased
    expect(h.order).toEqual([]);
    expect(h.clients).toEqual(['s1']);
  });

  it('the super_admin path still removes an owner who owns nothing else (unchanged)', async () => {
    await StoreService.delete('s1', 'admin-1');
    expect(h.order).toEqual(['identity-inactive', 'pg-delete-owner', 'identity-erase']);
  });

  it('finishDeletedStore re-runs the idempotent post-commit steps with no store row left (follow-up m2)', async () => {
    h.clients = [];
    await StoreService.finishDeletedStore({ id: 's1', slug: 's', ownerId: 'owner-1', onDo: false });
    expect(h.clients).toEqual(['s1']);
    // idempotent: a second run converges, never throws
    await StoreService.finishDeletedStore({ id: 's1', slug: 's', ownerId: 'owner-1', onDo: false });
    expect(h.clients).toEqual(['s1', 's1']);
  });
});
