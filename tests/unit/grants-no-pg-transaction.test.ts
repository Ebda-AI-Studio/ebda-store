/**
 * Ruling NZ-ACCT-1: once billing is served from D1 the grant paths run `fn` directly (every atomic piece is one D1
 * statement / batch), never inside a Postgres transaction (`runInTenantContext` has no Postgres on the Worker). A store still
 * on Postgres keeps its own transaction. `recordReferral` reads the owners from D1 `stores.owner_id` once access is on D1.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  billingOnD1: true,
  accessOnD1: true,
  runInTenantContext: vi.fn(),
  owners: {} as Record<string, string | null>,
  createMany: vi.fn(),
  withStore: vi.fn(),
}));

vi.mock('@ebda/database', () => {
  const empty = {
    findMany: async () => [],
    findFirst: async () => null,
    findUnique: async () => null,
    count: async () => 0,
  };
  return {
    prisma: new Proxy(
      { billingReferral: { createMany: (...a: unknown[]) => h.createMany(...a) } } as Record<
        string,
        unknown
      >,
      { get: (t, k) => (k in t ? t[k as string] : empty) }
    ),
    runInTenantContext: (...a: unknown[]) => h.runInTenantContext(...a),
    withStore: (...a: unknown[]) => h.withStore(...a),
    withRlsBypass: vi.fn(),
    runInStoreScope: vi.fn(),
    Prisma: {},
  };
});
vi.mock('@api/services/platform/billing-d1', () => ({
  onD1: async () => h.billingOnD1,
  lockSubscription: async () => false,
  applyGrantsBatchD1: vi.fn(),
  claimRestoreD1: vi.fn(),
  insertCappedGrant: vi.fn(),
  revokeGrantsD1: vi.fn(),
}));
vi.mock('@api/services/platform/access-d1', () => ({
  onAccessD1: async () => h.accessOnD1,
  storeOwnerIdD1: async (id: string) => h.owners[id] ?? null,
}));
vi.mock('@api/lib/platform-hub', () => ({
  hubOnD1: async () => true,
  hubStoresById: async () => [],
}));
vi.mock('@api/lib/definer', () => ({
  resolveStoreId: async ({ slug }: { slug: string }) => `store-of-${slug}`,
}));
vi.mock('@api/services/alerts.service', () => ({ sendAlert: vi.fn() }));
vi.mock('@api/services/platform/cutover', () => ({ assertFamilyWritableOnPostgres: vi.fn() }));

import { awardGrantsAfterPayment, recordReferral } from '@api/services/billing/grants.service';

beforeEach(() => {
  h.billingOnD1 = true;
  h.accessOnD1 = true;
  h.owners = { 'store-of-ref': 'owner-a', 'store-new': 'owner-b' };
  h.runInTenantContext.mockReset();
  h.runInTenantContext.mockImplementation(async (_id: string, fn: () => unknown) => fn());
  h.createMany.mockReset();
  h.createMany.mockResolvedValue({ count: 1 });
  h.withStore.mockReset();
});

describe('grants on D1', () => {
  it('awardGrantsAfterPayment opens no Postgres transaction when billing is on D1', async () => {
    await awardGrantsAfterPayment('store-new');
    expect(h.runInTenantContext).not.toHaveBeenCalled();
  });

  it('a store still on Postgres keeps its own transaction per beneficiary', async () => {
    h.billingOnD1 = false;
    await awardGrantsAfterPayment('store-new');
    expect(h.runInTenantContext).toHaveBeenCalledWith('store-new', expect.any(Function));
  });
});

describe('recordReferral on D1', () => {
  it('reads both owners from D1 and records the link', async () => {
    expect(await recordReferral('store-new', 'ref')).toBe(true);
    expect(h.withStore).not.toHaveBeenCalled();
    expect(h.createMany).toHaveBeenCalledWith({
      data: [{ referredStoreId: 'store-new', referrerStoreId: 'store-of-ref' }],
      skipDuplicates: true,
    });
  });

  it('refuses a self-referral by owner (same owner, two stores) and an unknown / deleted store', async () => {
    h.owners['store-new'] = 'owner-a';
    expect(await recordReferral('store-new', 'ref')).toBe(false);
    h.owners = { 'store-of-ref': 'owner-a', 'store-new': null };
    expect(await recordReferral('store-new', 'ref')).toBe(false);
    expect(h.createMany).not.toHaveBeenCalled();
  });

  it('a self store id is ignored without any read', async () => {
    expect(await recordReferral('store-of-ref', 'ref')).toBe(false);
    expect(h.createMany).not.toHaveBeenCalled();
  });
});
