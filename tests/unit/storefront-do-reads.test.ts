/**
 * NEON-ZERO-1 (N-2..N-5): the storefront reads of a Durable Object store touch no Postgres.
 *
 * Poisoned `@ebda/database`: any `withStore` / `runInTenantContext` / `prisma` use by a DO store throws, so these tests fail
 * if a read still leases a Postgres connection. The Postgres branch of each helper is asserted unchanged.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { storeRepoMock, db, poisoned } = vi.hoisted(() => ({
  storeRepoMock: vi.fn(),
  poisoned: () => {
    throw new Error('Postgres touched');
  },
  db: {
    store: { findUnique: vi.fn() },
    taxRate: { findMany: vi.fn() },
    storeTaxProfile: { findUnique: vi.fn() },
  },
}));
vi.mock('@ebda/database', () => ({
  currentTenantGucs: () => undefined,
  runInTenantContext: vi.fn(async (_s: string, fn: () => Promise<unknown>) => fn()),
  runInStoreScope: vi.fn(async (_s: string, fn: () => Promise<unknown>) => fn()),
  withStore: vi.fn(async (_s: string, fn: (tx: unknown) => Promise<unknown>) => fn(db)),
  prisma: new Proxy({}, { get: poisoned }),
}));
vi.mock('@api/lib/repo-factory', () => ({ storeRepo: (id: string) => storeRepoMock(id) }));

import { runInStoreScope, runInTenantContext, withStore } from '@ebda/database';
import { inDoStoreScope, readInStoreContext } from '@api/lib/store-scoped-read';
import { resolveActiveTaxRate } from '@api/lib/order-tax';

const STORE = '11111111-1111-4111-8111-111111111111';

beforeEach(() => {
  vi.clearAllMocks();
  db.store.findUnique.mockResolvedValue({ taxEnabled: true, taxIncludedInPrice: false });
  db.taxRate.findMany.mockResolvedValue([{ rate: 14 }]);
  db.storeTaxProfile.findUnique.mockResolvedValue({
    status: 'verified',
    taxRegistrationNumber: '123',
    legalName: 'Shop',
  });
});

describe('readInStoreContext / inDoStoreScope', () => {
  it('DO store: a bare store scope, no tenant transaction', async () => {
    storeRepoMock.mockResolvedValue({ backend: 'do' });
    expect(await readInStoreContext(STORE, async () => 'x')).toBe('x');
    expect(await inDoStoreScope(STORE, async () => 'y')).toBe('y');
    expect(runInTenantContext).not.toHaveBeenCalled();
    expect(runInStoreScope).toHaveBeenCalledTimes(2);
  });

  it('Postgres store: readInStoreContext keeps its tenant transaction, inDoStoreScope adds nothing', async () => {
    storeRepoMock.mockResolvedValue({ backend: 'pg' });
    expect(await readInStoreContext(STORE, async () => 'x')).toBe('x');
    expect(runInTenantContext).toHaveBeenCalledTimes(1);
    expect(await inDoStoreScope(STORE, async () => 'y')).toBe('y');
    expect(runInStoreScope).not.toHaveBeenCalled();
  });
});

describe('resolveActiveTaxRate', () => {
  it('DO store: reads the three facts from the DO client, never opens withStore', async () => {
    storeRepoMock.mockResolvedValue({ backend: 'do', db });
    const r = await resolveActiveTaxRate(STORE);
    expect(r).toMatchObject({ ratePercent: 14, includedInPrice: false });
    expect(r.seller).toEqual({ taxRegistrationNumber: '123', legalName: 'Shop' });
    expect(withStore).not.toHaveBeenCalled();
  });

  it('Postgres store: the unchanged withStore read gives the same answer', async () => {
    storeRepoMock.mockResolvedValue({ backend: 'pg', db: new Proxy({}, { get: poisoned }) });
    const r = await resolveActiveTaxRate(STORE);
    expect(r).toMatchObject({ ratePercent: 14, includedInPrice: false });
    expect(withStore).toHaveBeenCalledTimes(1);
  });

  it('the VAT gate holds on a DO store: an unverified profile charges nothing', async () => {
    storeRepoMock.mockResolvedValue({ backend: 'do', db });
    db.storeTaxProfile.findUnique.mockResolvedValue({
      status: 'pending',
      taxRegistrationNumber: '123',
      legalName: 'Shop',
    });
    expect(await resolveActiveTaxRate(STORE)).toMatchObject({ ratePercent: 0, seller: null });
  });
});
