/**
 * #1599: `isStillReferenced` (inside r2-cleanup.service.ts) used to run its
 * global existence probes on whichever Prisma client the caller happened
 * to be using — the ambient tenant proxy under `deferAfterTenantCommit`. That
 * is latent today only because production connects as a BYPASSRLS role, but
 * becomes a store-FILTERED (wrong) check the moment RLS actually applies,
 * causing an irreversible R2 delete of a still-referenced cross-tenant row.
 *
 * The probe is now ONE statement built from the shared R2 reference registry
 * (lib/r2-references.ts). This proves it runs on the client `withRlsBypass`
 * hands it (`tx`), not the bare `prisma` export — by making `withRlsBypass` a
 * spy that returns a DIFFERENT, trackable client than `prisma`, and asserting
 * the query landed on that client.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const {
  queryRaw,
  executeRaw,
  bypassTx,
  prismaQueryRaw,
  prismaDecoy,
  withRlsBypassMock,
  storeFindMany,
} = vi.hoisted(() => {
  const queryRaw = vi.fn().mockResolvedValue([{ referenced: false }]);
  const executeRaw = vi.fn().mockResolvedValue(0);
  const bypassTx = { $queryRawUnsafe: queryRaw, $executeRaw: executeRaw };

  // A DISTINCT client from `bypassTx` — if the source under test ever queries
  // straight through `prisma` instead of `tx`, this decoy would be the one
  // invoked, and the assertions below would catch it.
  const prismaQueryRaw = vi.fn().mockResolvedValue([{ referenced: false }]);
  // `stores` is under RLS: the stores are listed through the directory definer (`storeDirectory`),
  // and everything else is read per store, in that store's scope.
  const storeFindMany = vi.fn().mockResolvedValue([{ id: 'store-1' }]);
  const prismaDecoy = { $queryRawUnsafe: prismaQueryRaw };

  const withRlsBypassMock = vi.fn(
    (_storeId: string, fn: (tx: typeof bypassTx) => Promise<unknown>) => fn(bypassTx)
  );

  return {
    queryRaw,
    executeRaw,
    bypassTx,
    prismaQueryRaw,
    prismaDecoy,
    withRlsBypassMock,
    storeFindMany,
  };
});

vi.mock('@ebda/database', () => ({
  // no store in scope: these cases delete legacy flat keys (the store-prefix guard has its own test)
  currentStoreId: () => {
    throw new Error('no ambient store');
  },
  prisma: prismaDecoy,
  storeDirectory: storeFindMany,
  withStore: withRlsBypassMock,
}));
vi.mock('../../apps/api/src/services/storage.service', () => ({
  StorageService: {
    isAvailable: () => true,
    delete: vi.fn().mockResolvedValue(undefined),
  },
}));
vi.mock('../../apps/api/src/lib/logger', () => ({
  default: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
}));
vi.mock('../../apps/api/src/config', () => ({
  config: {
    storagePublicUrl: 'https://cdn.example.com',
    storageEndpoint: '',
    storageBucket: '',
  },
}));

import { deleteR2ObjectIfOrphan } from '../../apps/api/src/services/r2-cleanup.service';

beforeEach(() => {
  vi.clearAllMocks();
  queryRaw.mockResolvedValue([{ referenced: false }]);
  prismaQueryRaw.mockResolvedValue([{ referenced: false }]);
});

describe('r2-cleanup isStillReferenced reads every store in its own scope (#1599)', () => {
  it('goes through withStore (one scope per store), not the bare prisma export', async () => {
    await deleteR2ObjectIfOrphan('https://cdn.example.com/products/some-key.jpg');

    // Soft-deleted stores are listed too: a clone's reference there still counts (safe direction).
    expect(storeFindMany).toHaveBeenCalledWith(undefined, { includeDeleted: true });
    expect(withRlsBypassMock).toHaveBeenCalledTimes(1); // the one store listed
    // The registry-built probes landed on the bypass client: the exact-URL
    // half first (with the URL), then — because it missed — the substring
    // half over the JSON/HTML columns (with the R2 key). issue 2249.
    expect(queryRaw).toHaveBeenCalledTimes(2);
    const [exactSql, url] = queryRaw.mock.calls[0]!;
    expect(url).toBe('https://cdn.example.com/products/some-key.jpg');
    expect(exactSql).toContain('"product_images"');
    expect(exactSql).not.toContain('position(');
    const [substringSql, key] = queryRaw.mock.calls[1]!;
    expect(key).toBe('products/some-key.jpg');
    expect(substringSql).toContain('"pwa_settings"');
    // The scan is time-bounded on the same transaction (issue 2249).
    expect((executeRaw.mock.calls[0][0] as TemplateStringsArray).join('?')).toContain(
      "set_config('statement_timeout'"
    );
    // ...and NOTHING landed on the un-scoped decoy.
    expect(prismaQueryRaw).not.toHaveBeenCalled();
    expect(bypassTx.$queryRawUnsafe).toBe(queryRaw);
  });

  it('a reference in ANY store keeps the object (the check is the OR over every store)', async () => {
    storeFindMany.mockResolvedValueOnce([{ id: 'store-1' }, { id: 'store-2' }]);
    // store-1: exact + substring miss; store-2: exact hit
    queryRaw
      .mockResolvedValueOnce([{ referenced: false }])
      .mockResolvedValueOnce([{ referenced: false }])
      .mockResolvedValueOnce([{ referenced: true }]);
    const { StorageService } = await import('../../apps/api/src/services/storage.service');

    await deleteR2ObjectIfOrphan('https://cdn.example.com/products/shared.jpg');

    expect(withRlsBypassMock.mock.calls.map(c => c[0])).toEqual(['store-1', 'store-2']);
    expect(StorageService.delete).not.toHaveBeenCalled();
  });

  it('still refuses to delete when the store scope finds a reference', async () => {
    queryRaw.mockResolvedValueOnce([{ referenced: true }]);
    const { StorageService } = await import('../../apps/api/src/services/storage.service');

    await deleteR2ObjectIfOrphan('https://cdn.example.com/products/still-used.jpg');

    expect(StorageService.delete).not.toHaveBeenCalled();
  });

  it('skips the substring scan when an exact-URL reference exists (issue 2249)', async () => {
    queryRaw.mockResolvedValueOnce([{ referenced: true }]);
    const { StorageService } = await import('../../apps/api/src/services/storage.service');
    await deleteR2ObjectIfOrphan('https://cdn.example.com/products/cloned.jpg');
    expect(queryRaw).toHaveBeenCalledTimes(1);
    expect(StorageService.delete).not.toHaveBeenCalled();
  });

  it('KEEPS the object when the bounded scan times out (57014) — never deletes on doubt', async () => {
    queryRaw
      .mockResolvedValueOnce([{ referenced: false }])
      .mockRejectedValueOnce(
        Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' })
      );
    const { StorageService } = await import('../../apps/api/src/services/storage.service');
    await deleteR2ObjectIfOrphan('https://cdn.example.com/products/slow.jpg');
    expect(StorageService.delete).not.toHaveBeenCalled();
  });

  it('deletes when nothing references the object', async () => {
    const { StorageService } = await import('../../apps/api/src/services/storage.service');

    await deleteR2ObjectIfOrphan('https://cdn.example.com/products/orphan.jpg');

    expect(StorageService.delete).toHaveBeenCalledWith('products/orphan.jpg');
  });
});
