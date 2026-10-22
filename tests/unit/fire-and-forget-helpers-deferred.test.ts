/**
 * Unit test — the two shared fire-and-forget helpers defer past the commit.
 *
 * These two are the widest surfaces of the P2028 class, which is why the fix
 * lives inside the helper rather than at each of the ~20 call sites (a fix in
 * the shared component sweeps every caller, including future ones):
 *
 *  - `deleteR2ObjectIfOrphan` (r2-cleanup.service) — a Prisma read (then
 *    eleven, now one registry-built statement) via `isStillReferenced`, called `void`-style from product / variant /
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
  return {
    prismaMock: {
      // isStillReferenced's single registry-built probe (lib/r2-references.ts).
      $queryRawUnsafe: vi.fn().mockResolvedValue([{ referenced: false }]),
      // r2-cleanup bounds its orphan scan with set_config('statement_timeout').
      $executeRaw: vi.fn().mockResolvedValue(0),
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

vi.mock('@ebda/database', () => ({
  prisma: prismaMock,
  // isStillReferenced lists the stores through the directory definer (`stores` is under RLS).
  storeDirectory: vi.fn().mockResolvedValue([{ id: 'store-1' }]),
  // the store the fixtures' keys (`stores/x/...`) belong to: the delete only touches the current
  // store's own namespace (tests/unit/r2-cleanup-store-prefix.test.ts)
  currentStoreId: () => 'x',
  runInTenantContext: runInTenantContextMock,
  onClosedTenantTxAccess: vi.fn(),
  hasTenantContext: vi.fn(() => false),
  // isStillReferenced reads store by store through `withStore`: this file's concern is
  // COMMIT-TIMING (the header docstring), not RLS routing (that has its own coverage in
  // tests/unit/r2-cleanup-rls-bypass.test.ts), so the callback runs against the SAME mocks the
  // rest of this file asserts against.
  withStore: (_storeId: string, fn: (tx: typeof prismaMock) => unknown) => fn(prismaMock),
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
  prismaMock.$queryRawUnsafe.mockResolvedValue([{ referenced: false }]);
  prismaMock.affiliateEvent.create.mockResolvedValue({ id: 'evt-1' });
  runInTenantContextMock.mockImplementation(
    async (_storeId: string | undefined, fn: () => Promise<unknown>) => fn()
  );
});

describe('deleteR2ObjectIfOrphan', () => {
  it('makes no Prisma call while the request transaction is open, then runs after it commits', async () => {
    await withDeferredWork({ storeId: STORE_ID }, async () => {
      await deleteR2ObjectIfOrphan(OUR_URL);
      expect(prismaMock.$queryRawUnsafe).not.toHaveBeenCalled();
      expect(storageMock.delete).not.toHaveBeenCalled();
    });

    expect(prismaMock.$queryRawUnsafe).toHaveBeenCalled();
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

/**
 * Issue 2042 — outside a request (Inngest bulk import, crons, scripts) every
 * removed URL used to open its own pinned `withRlsBypass` transaction AT ONCE
 * (`Promise.all`), N of them against a 15-connection pool shared with the
 * storefront; the losers timed out and the objects leaked. The checks now run
 * one at a time, as a single deferred task.
 *
 * Mutation proof: restore `Promise.all(removed.map(deleteR2ObjectIfOrphan))`
 * → the peak-concurrency assertion goes red.
 */
describe('cleanupRemovedImages — bounded fan-out (issue 2042)', () => {
  it('checks removed URLs one at a time outside a request', async () => {
    let inFlight = 0;
    let peak = 0;
    prismaMock.$queryRawUnsafe.mockImplementation(async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise(r => setTimeout(r, 5));
      inFlight--;
      return [{ referenced: false }];
    });
    const removed = Array.from(
      { length: 20 },
      (_, i) => `https://cdn.example.com/stores/x/s/${i}.png`
    );

    await cleanupRemovedImages(removed, []);

    // Two statements per URL: the exact-URL probe, then (on a miss) the
    // substring scan (issue 2249).
    expect(prismaMock.$queryRawUnsafe).toHaveBeenCalledTimes(40);
    expect(storageMock.delete).toHaveBeenCalledTimes(20);
    expect(peak).toBe(1);
  });

  it('inside a request, queues ONE task that runs after the commit', async () => {
    prismaMock.$queryRawUnsafe.mockResolvedValue([{ referenced: false }]);
    await withDeferredWork({ storeId: STORE_ID }, async () => {
      void cleanupRemovedImages(
        ['https://cdn.example.com/stores/x/a.png', 'https://cdn.example.com/stores/x/b.png'],
        []
      );
      expect(storageMock.delete).not.toHaveBeenCalled();
    });
    expect(runInTenantContextMock).toHaveBeenCalledTimes(1);
    expect(storageMock.delete).toHaveBeenCalledTimes(2);
  });
});
