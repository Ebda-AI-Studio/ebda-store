/**
 * M1 of the #772 re-review: on a Durable Object store the deletion-request compare-and-set must be ONE conditional operation
 * inside the StoreDO (a precondition on the patch), not read -> patch -> read-back from the API Worker (racy: a cancel and the
 * executor's claim both "won").
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
const patch = vi.hoisted(() => ({ fn: vi.fn(), twoWrites: false }));
vi.mock('@api/lib/repo-factory', async () => {
  const real = await vi.importActual<Record<string, unknown>>('@api/lib/repo-factory');
  return {
    ...real,
    storeWritesToDo: async () => true,
    storePatchOnDo: (...a: unknown[]) => patch.fn(...a),
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
const { AppError } = await import('@api/middleware/error-handler');

beforeEach(() => {
  patch.fn = vi.fn(async () => ({}));
  vi.spyOn(StoreService, 'getById').mockResolvedValue({
    id: 's1',
    ownerId: 'owner-1',
    slug: 's',
    domain: null,
    settings: { deletionRequest: { id: 'r1', state: 'pending' } },
  } as never);
  vi.spyOn(StoreService as never, 'afterDeletionRequestWrite' as never).mockResolvedValue(
    undefined as never
  );
});

describe('compareAndSetDeletionRequest on a Durable Object store', () => {
  const from = { id: 'r1', state: 'pending' };
  const to = { id: 'r1', state: 'executing' };

  it('sends the precondition INSIDE the DO patch (one call), not a read-then-write from the Worker', async () => {
    expect(await StoreService.compareAndSetDeletionRequest('s1', from, to)).toBe(true);
    expect(patch.fn).toHaveBeenCalledTimes(1);
    expect(patch.fn.mock.calls[0][1]).toEqual({
      json: {
        settings: {
          set: { deletionRequest: to },
          expect: { deletionRequest: { id: 'r1', state: 'pending' } },
        },
      },
    });
  });

  it('a precondition the DO refuses is a lost race (false), whatever the Worker last read', async () => {
    patch.fn = vi.fn(async () => {
      throw new AppError(409, 'PATCH_PRECONDITION_FAILED', 'changed');
    });
    expect(await StoreService.compareAndSetDeletionRequest('s1', from, to)).toBe(false);
  });

  it('any other DO failure is thrown, not swallowed as a lost race', async () => {
    patch.fn = vi.fn(async () => {
      throw new AppError(502, 'SETTINGS_COPY_FAILED', 'down');
    });
    await expect(StoreService.compareAndSetDeletionRequest('s1', from, to)).rejects.toThrow('down');
  });
});
