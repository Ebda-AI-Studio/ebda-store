/**
 * Unit test — the two shared fire-and-forget helpers defer past the commit.
 *
 * These two are the widest surfaces of the P2028 class, which is why the fix
 * lives inside the helper rather than at each of the ~20 call sites (a fix in
 * the shared component sweeps every caller, including future ones):
 *
 *  - `deleteR2ObjectIfOrphan` (r2-cleanup.service) — ELEVEN Prisma reads via
 *    `isStillReferenced`, called `void`-style from product / variant /
 *    category / page / blog / store / typography / layout save paths, most of
 *    which DO run under `tenantContext`. Every one of those reads died on the
 *    committed transaction and was swallowed as "[r2-cleanup] failed to
 *    delete orphan R2 object" — so the object leaked, which is the exact
 *    failure the service exists to prevent.
 *
 *  - `recordAffiliateEvent` (affiliate-event.service) — one `create` on the
 *    append-only affiliate audit log, fired `void`-style from eight call
 *    sites in affiliate.service, whose router DOES register
 *    `router.param('storeId', tenantContext)`. Swallowed the same way.
 *
 * Revert either helper to its pre-fix body and the "not while the transaction
 * is open" assertion reddens.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { prismaMock, runInTenantContextMock, storageMock, loggerMock } = vi.hoisted(() => {
  const findFirst = vi.fn().mockResolvedValue(null);
  return {
    prismaMock: {
      productImage: { findFirst },
      productVariant: { findFirst },
      category: { findFirst },
      storePage: { findFirst },
      blogPost: { findFirst },
      store: { findFirst },
      user: { findFirst },
      affiliateEvent: { create: vi.fn().mockResolvedValue({ id: 'evt-1' }) },
    },
    runInTenantContextMock: vi.fn(
      async (_storeId: string | undefined, fn: () => Promise<unknown>) => fn()
    ),
    storageMock: {
      isAvailable: vi.fn().mockReturnValue(true),
      delete: vi.fn().mockResolvedValue(undefined),
    },
    loggerMock: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
  };
});

vi.mock('@force/database', () => ({
  withRlsBypass: (fn: (tx: unknown) => unknown) => fn(prismaMock),
  prisma: prismaMock,
  runInTenantContext: runInTenantContextMock,
  onClosedTenantTxAccess: vi.fn(),
  // #1599: isStillReferenced now runs its 11 probes through `withRlsBypass`,
  // not the bare `prisma` export — this file's concern is COMMIT-TIMING (the
  // header docstring), not RLS routing (that has its own dedicated coverage
  // in tests/unit/r2-cleanup-rls-bypass.test.ts), so this just runs the
  // callback against the SAME mocks the rest of this file already asserts
  // against.
  withRlsBypass: (fn: (tx: typeof prismaMock) => unknown) => fn(prismaMock),
}));

vi.mock('@api/services/storage.service', () => ({ StorageService: storageMock }));
vi.mock('@api/services/alerts.service', () => ({ sendAlert: vi.fn().mockResolvedValue('sent') }));
vi.mock('@api/lib/logger', () => ({ default: loggerMock }));
vi.mock('@api/config', () => ({
  config: {
    storagePublicUrl: 'https://cdn.example.com',
    storageEndpoint: null,
    storageBucket: null,
  },
}));

import { deleteR2ObjectIfOrphan, cleanupRemovedImages } from '@api/services/r2-cleanup.service';
import { recordAffiliateEvent } from '@api/services/affiliate-event.service';
import { withDeferredWork } from '@api/lib/after-tenant-commit';

const STORE_ID = '11111111-1111-1111-1111-111111111111';
const OUR_URL = 'https://cdn.example.com/stores/x/hero.png';

beforeEach(() => {
  vi.clearAllMocks();
  storageMock.isAvailable.mockReturnValue(true);
  prismaMock.productImage.findFirst.mockResolvedValue(null);
  prismaMock.affiliateEvent.create.mockResolvedValue({ id: 'evt-1' });
  runInTenantContextMock.mockImplementation(
    async (_storeId: string | undefined, fn: () => Promise<unknown>) => fn()
  );
});

describe('deleteR2ObjectIfOrphan', () => {
  it('makes no Prisma call while the request transaction is open, then runs after it commits', async () => {
    await withDeferredWork({ storeId: STORE_ID }, async () => {
      await deleteR2ObjectIfOrphan(OUR_URL);
      expect(prismaMock.productImage.findFirst).not.toHaveBeenCalled();
      expect(storageMock.delete).not.toHaveBeenCalled();
    });

    expect(prismaMock.productImage.findFirst).toHaveBeenCalled();
    expect(storageMock.delete).toHaveBeenCalledWith('stores/x/hero.png');
  });

  it('runs inline with no request transaction (Inngest / scripts unchanged)', async () => {
    await deleteR2ObjectIfOrphan(OUR_URL);

    expect(storageMock.delete).toHaveBeenCalledWith('stores/x/hero.png');
    expect(runInTenantContextMock).not.toHaveBeenCalled();
  });

  it('defers one task per removed URL through cleanupRemovedImages', async () => {
    const removedA = 'https://cdn.example.com/stores/x/a.png';
    const removedB = 'https://cdn.example.com/stores/x/b.png';

    await withDeferredWork({ storeId: STORE_ID }, async () => {
      await cleanupRemovedImages([removedA, removedB, OUR_URL], [OUR_URL]);
      expect(storageMock.delete).not.toHaveBeenCalled();
    });

    expect(storageMock.delete.mock.calls.map(c => c[0]).sort()).toEqual([
      'stores/x/a.png',
      'stores/x/b.png',
    ]);
  });
});

describe('recordAffiliateEvent', () => {
  const input = {
    affiliateId: 'aff-1',
    storeId: STORE_ID,
    eventType: 'created',
    toStatus: 'pending',
  };

  it('writes the audit row after the request transaction commits, not during it', async () => {
    let deferredReturn: unknown = 'unset';

    await withDeferredWork({ storeId: STORE_ID }, async () => {
      deferredReturn = await recordAffiliateEvent(input);
      expect(prismaMock.affiliateEvent.create).not.toHaveBeenCalled();
    });

    expect(deferredReturn).toBeNull();
    expect(prismaMock.affiliateEvent.create).toHaveBeenCalledTimes(1);
    expect(prismaMock.affiliateEvent.create.mock.calls[0][0]).toMatchObject({
      data: expect.objectContaining({ affiliateId: 'aff-1', storeId: STORE_ID }),
    });
  });

  it('runs inline and returns the created row with no request transaction', async () => {
    await expect(recordAffiliateEvent(input)).resolves.toEqual({ id: 'evt-1' });
    expect(prismaMock.affiliateEvent.create).toHaveBeenCalledTimes(1);
  });
});
