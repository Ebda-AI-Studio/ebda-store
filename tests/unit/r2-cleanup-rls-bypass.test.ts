/**
 * #1599: `isStillReferenced` (inside r2-cleanup.service.ts) used to run its
 * 11 global existence probes on whichever Prisma client the caller happened
 * to be using — the ambient tenant proxy under `deferAfterTenantCommit`. That
 * is latent today only because production connects as a BYPASSRLS role, but
 * becomes a store-FILTERED (wrong) check the moment RLS actually applies,
 * causing an irreversible R2 delete of a still-referenced cross-tenant row.
 *
 * This proves the probes run on the client `withRlsBypass` hands them
 * (`tx`), not the bare `prisma` export — by making `withRlsBypass` a spy
 * that returns a DIFFERENT, trackable client than `prisma`, and asserting
 * every model call landed on that client.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { findFirst, bypassTx, prismaFindFirst, prismaDecoy, withRlsBypassMock } = vi.hoisted(() => {
  const findFirst = vi.fn().mockResolvedValue(null);
  const bypassTx = {
    productImage: { findFirst },
    productVariant: { findFirst },
    category: { findFirst },
    storePage: { findFirst },
    blogPost: { findFirst },
    store: { findFirst },
    user: { findFirst },
  };

  // A DISTINCT client from `bypassTx` — if the source under test ever calls
  // straight through `prisma.<model>.findFirst` instead of `tx.<model>.findFirst`,
  // this decoy would be the one invoked, and the assertions below would catch
  // it (the decoy is asserted to be untouched).
  const prismaFindFirst = vi.fn().mockResolvedValue(null);
  const prismaDecoy = {
    productImage: { findFirst: prismaFindFirst },
    productVariant: { findFirst: prismaFindFirst },
    category: { findFirst: prismaFindFirst },
    storePage: { findFirst: prismaFindFirst },
    blogPost: { findFirst: prismaFindFirst },
    store: { findFirst: prismaFindFirst },
    user: { findFirst: prismaFindFirst },
  };

  const withRlsBypassMock = vi.fn((fn: (tx: typeof bypassTx) => Promise<unknown>) => fn(bypassTx));

  return { findFirst, bypassTx, prismaFindFirst, prismaDecoy, withRlsBypassMock };
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
  findFirst.mockResolvedValue(null);
  prismaFindFirst.mockResolvedValue(null);
});

describe('r2-cleanup isStillReferenced runs on an RLS-bypass client (#1599)', () => {
  it('goes through withRlsBypass, not the bare prisma export', async () => {
    await deleteR2ObjectIfOrphan('https://cdn.example.com/products/some-key.jpg');

    expect(withRlsBypassMock).toHaveBeenCalledTimes(1);
    // Every one of the 11 probes landed on the bypass client...
    expect(findFirst).toHaveBeenCalled();
    expect(findFirst.mock.calls.length).toBeGreaterThanOrEqual(7); // 7 distinct models above
    // ...and NONE landed on the un-scoped decoy.
    expect(prismaFindFirst).not.toHaveBeenCalled();
  });

  it('still refuses to delete when the bypass client finds a reference', async () => {
    findFirst.mockResolvedValueOnce({ id: 'still-referenced-row' });
    const { StorageService } = await import('../../apps/api/src/services/storage.service');

    await deleteR2ObjectIfOrphan('https://cdn.example.com/products/still-used.jpg');

    expect(StorageService.delete).not.toHaveBeenCalled();
  });
});
