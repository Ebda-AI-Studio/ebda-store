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

const { queryRaw, bypassTx, prismaQueryRaw, prismaDecoy, withRlsBypassMock } = vi.hoisted(() => {
  const queryRaw = vi.fn().mockResolvedValue([{ referenced: false }]);
  const bypassTx = { $queryRawUnsafe: queryRaw };

  // A DISTINCT client from `bypassTx` — if the source under test ever queries
  // straight through `prisma` instead of `tx`, this decoy would be the one
  // invoked, and the assertions below would catch it.
  const prismaQueryRaw = vi.fn().mockResolvedValue([{ referenced: false }]);
  const prismaDecoy = { $queryRawUnsafe: prismaQueryRaw };

  const withRlsBypassMock = vi.fn((fn: (tx: typeof bypassTx) => Promise<unknown>) => fn(bypassTx));

  return { queryRaw, bypassTx, prismaQueryRaw, prismaDecoy, withRlsBypassMock };
});

vi.mock('@force/database', () => ({
  prisma: prismaDecoy,
  withRlsBypass: withRlsBypassMock,
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

describe('r2-cleanup isStillReferenced runs on an RLS-bypass client (#1599)', () => {
  it('goes through withRlsBypass, not the bare prisma export', async () => {
    await deleteR2ObjectIfOrphan('https://cdn.example.com/products/some-key.jpg');

    expect(withRlsBypassMock).toHaveBeenCalledTimes(1);
    // The single registry-built probe landed on the bypass client, with the
    // URL (exact-match columns) and the R2 key (JSON/HTML columns)...
    expect(queryRaw).toHaveBeenCalledTimes(1);
    const [sql, url, key] = queryRaw.mock.calls[0]!;
    expect(url).toBe('https://cdn.example.com/products/some-key.jpg');
    expect(key).toBe('products/some-key.jpg');
    expect(sql).toContain('"pwa_settings"');
    expect(sql).toContain('"product_images"');
    // ...and NOTHING landed on the un-scoped decoy.
    expect(prismaQueryRaw).not.toHaveBeenCalled();
    expect(bypassTx.$queryRawUnsafe).toBe(queryRaw);
  });

  it('still refuses to delete when the bypass client finds a reference', async () => {
    queryRaw.mockResolvedValueOnce([{ referenced: true }]);
    const { StorageService } = await import('../../apps/api/src/services/storage.service');

    await deleteR2ObjectIfOrphan('https://cdn.example.com/products/still-used.jpg');

    expect(StorageService.delete).not.toHaveBeenCalled();
  });

  it('deletes when nothing references the object', async () => {
    const { StorageService } = await import('../../apps/api/src/services/storage.service');

    await deleteR2ObjectIfOrphan('https://cdn.example.com/products/orphan.jpg');

    expect(StorageService.delete).toHaveBeenCalledWith('products/orphan.jpg');
  });
});
