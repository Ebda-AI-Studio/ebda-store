/**
 * VS-9 (register row 24): the Customer Intelligence page returned 500 DATABASE_ERROR because the CI source read a store's
 * `ciSharing` through a bare Postgres tenant transaction, which throws `PostgresRemovedError` for a store on its Durable Object.
 * This fails if that read goes back to `runInTenantContext`/`prisma` for a DO store.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  storeRepo: vi.fn(),
  tenant: vi.fn(),
  scope: vi.fn(),
  findFirst: vi.fn(),
}));

vi.mock('@ebda/database', () => ({
  prisma: new Proxy(
    {},
    {
      get: () => {
        throw new Error('PostgresRemovedError: prisma touched');
      },
    }
  ),
  runInTenantContext: h.tenant,
  runInStoreScope: h.scope,
}));
vi.mock('../../apps/api/src/lib/repo-factory', () => ({
  storeRepo: h.storeRepo,
  storeMoney: vi.fn(),
}));
vi.mock('../../apps/api/src/lib/identity-client', () => ({ getAccountsBrief: vi.fn() }));

import { prismaCiSource } from '../../apps/api/src/lib/ci/source';

const ST = '3f6f0a52-6b0a-4c55-8e38-2b2b6b1c8a10';

beforeEach(() => {
  vi.clearAllMocks();
  h.tenant.mockRejectedValue(new Error('PostgresRemovedError: tenant transaction on a DO store'));
  h.scope.mockImplementation((_id: string, fn: () => unknown) => fn());
  h.findFirst.mockResolvedValue({ ciSharing: true });
});

describe('prismaCiSource.storeCiSharing', () => {
  it('reads a Durable Object store through its own scope, never a Postgres transaction', async () => {
    h.storeRepo.mockResolvedValue({ backend: 'do', db: { store: { findFirst: h.findFirst } } });
    await expect(prismaCiSource.storeCiSharing(ST)).resolves.toBe(true);
    expect(h.scope).toHaveBeenCalledWith(ST, expect.any(Function));
    expect(h.tenant).not.toHaveBeenCalled();
    expect(h.findFirst).toHaveBeenCalledWith({ where: { id: ST }, select: { ciSharing: true } });
  });

  it('a Postgres store keeps its tenant scope', async () => {
    h.tenant.mockImplementation((_id: string, fn: () => unknown) => fn());
    h.storeRepo.mockResolvedValue({ backend: 'pg', db: { store: { findFirst: h.findFirst } } });
    await expect(prismaCiSource.storeCiSharing(ST)).resolves.toBe(true);
    expect(h.tenant).toHaveBeenCalledWith(ST, expect.any(Function));
  });

  it('an unresolved store reads as not sharing (false), not an error', async () => {
    h.storeRepo.mockResolvedValue({
      backend: 'do',
      db: { store: { findFirst: vi.fn().mockResolvedValue(null) } },
    });
    await expect(prismaCiSource.storeCiSharing(ST)).resolves.toBe(false);
  });
});
