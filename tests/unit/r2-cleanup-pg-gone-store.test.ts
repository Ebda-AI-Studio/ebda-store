/**
 * 2026-11-09: `isStillReferenced` walks every store incl. soft-deleted. The pg-flagged `qa-merchant-test` has no Postgres to read on
 * the Worker, so its `withStore` threw, the caller KEPT the object, and no orphan image was ever deleted. It is skipped now.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../apps/api/src/lib/postgres-present', () => ({
  postgresRemovedOnThisWorker: () => true,
}));
vi.mock('../../apps/api/src/lib/store-backend', () => ({
  backendFor: async (id: string) => (id === 'do-1' ? 'do' : 'pg'),
}));
vi.mock('@ebda/database', () => ({
  currentStoreId: () => {
    throw new Error('no ambient store');
  },
  prisma: {},
  storeDirectory: async () => [{ id: 'pg-gone' }, { id: 'do-1' }],
  withStore: async (id: string, fn: (tx: unknown) => Promise<unknown>) => {
    if (id === 'pg-gone') throw new Error('POSTGRES_REMOVED');
    return fn({ $executeRaw: async () => 0, $queryRawUnsafe: async () => [{ referenced: false }] });
  },
}));
vi.mock('../../apps/api/src/lib/r2-do-references', () => ({
  collectDoStoreReferencedKeys: async () => new Set<string>(),
}));
vi.mock('../../apps/api/src/lib/r2-platform-d1-references', () => ({
  platformD1ReferencedKeys: async () => new Set<string>(),
}));
vi.mock('../../apps/api/src/services/storage.service', () => ({
  StorageService: { isAvailable: () => true, delete: vi.fn().mockResolvedValue(undefined) },
}));
vi.mock('../../apps/api/src/lib/logger', () => ({
  default: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
}));
vi.mock('../../apps/api/src/config', () => ({
  config: { storagePublicUrl: 'https://cdn.example.com', storageEndpoint: '', storageBucket: '' },
}));

import { deleteR2ObjectIfOrphan } from '../../apps/api/src/services/r2-cleanup.service';
import { StorageService } from '../../apps/api/src/services/storage.service';

beforeEach(() => vi.clearAllMocks());

describe('R2 orphan check with a pg-gone store in the directory', () => {
  it('skips it and still deletes a truly orphaned object', async () => {
    await deleteR2ObjectIfOrphan('https://cdn.example.com/products/orphan.jpg');
    expect(StorageService.delete).toHaveBeenCalledTimes(1);
  });
});
