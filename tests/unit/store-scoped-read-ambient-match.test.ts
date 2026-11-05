/**
 * issue 2041 — readInStoreContext must reuse the ambient tenant transaction
 * ONLY when it is scoped to the requested store. A transaction with no store
 * GUC (`userContext` on /addresses, a header-less /wishlist) or another
 * store's GUC reads a STRICT table as [] under ebda_app. The real-RLS proof
 * is in tests/integration/rls-ebda-app.test.ts (run on an ebda_app login);
 * this unit pin is what the defence-mutation record runs.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  gucs: undefined as { storeId?: string; userId?: string } | undefined,
  runInTenantContext: vi.fn(),
  runInStoreScope: vi.fn(),
  backend: 'pg' as 'pg' | 'do',
}));

vi.mock('@ebda/database', () => ({
  currentTenantGucs: () => h.gucs,
  runInTenantContext: h.runInTenantContext,
  runInStoreScope: h.runInStoreScope,
}));
vi.mock('../../apps/api/src/lib/repo-factory', () => ({
  storeRepo: async () => ({ backend: h.backend }),
}));

import { readInStoreContext } from '../../apps/api/src/lib/store-scoped-read';

const STORE_A = '11111111-1111-4111-8111-111111111111';
const STORE_B = '22222222-2222-4222-8222-222222222222';

describe('readInStoreContext — ambient store must match (issue 2041)', () => {
  beforeEach(() => {
    h.backend = 'pg';
    h.runInTenantContext
      .mockReset()
      .mockImplementation(async (_s: string, fn: () => unknown) => fn());
    h.runInStoreScope.mockReset().mockImplementation(async (_s: string, fn: () => unknown) => fn());
  });

  it('opens a scoped transaction when the ambient one has NO store (user-scoped router)', async () => {
    h.gucs = { userId: 'u1' };
    await readInStoreContext(STORE_B, async () => 1);
    expect(h.runInTenantContext).toHaveBeenCalledWith(STORE_B, expect.any(Function));
  });

  it('opens a scoped transaction when the ambient one is ANOTHER store', async () => {
    h.gucs = { storeId: STORE_A };
    await readInStoreContext(STORE_B, async () => 1);
    expect(h.runInTenantContext).toHaveBeenCalledWith(STORE_B, expect.any(Function));
  });

  it('reuses the ambient transaction when it is the SAME store', async () => {
    h.gucs = { storeId: STORE_B };
    await expect(readInStoreContext(STORE_B, async () => 7)).resolves.toBe(7);
    expect(h.runInTenantContext).not.toHaveBeenCalled();
  });

  it('opens a scoped transaction with no context at all', async () => {
    h.gucs = undefined;
    await readInStoreContext(STORE_B, async () => 1);
    expect(h.runInTenantContext).toHaveBeenCalledWith(STORE_B, expect.any(Function));
  });

  it('a DO store gets a bare store scope instead: no Postgres transaction is opened for it (NEON-ZERO-1)', async () => {
    h.backend = 'do';
    h.gucs = undefined;
    await expect(readInStoreContext(STORE_B, async () => 9)).resolves.toBe(9);
    expect(h.runInTenantContext).not.toHaveBeenCalled();
    expect(h.runInStoreScope).toHaveBeenCalledWith(STORE_B, expect.any(Function));
  });

  it('a DO store already inside its own tenant transaction just runs', async () => {
    h.backend = 'do';
    h.gucs = { storeId: STORE_B };
    await expect(readInStoreContext(STORE_B, async () => 3)).resolves.toBe(3);
    expect(h.runInStoreScope).not.toHaveBeenCalled();
  });
});
