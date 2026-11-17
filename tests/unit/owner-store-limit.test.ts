/**
 * The owner's store limit. Two independent limits apply and the stricter wins:
 *   - the PAID PLAN allowance (maxStores 1 / 1 / 3 / unlimited): upgrade prompt when exceeded, never lifted by staff;
 *   - the owner's ABUSE cap: 3 by default; staff can set it from 3 to 20 by RESOLVING a store-limit request (the LATEST
 *     decision wins, so it can be raised or lowered).
 * effective = min(plan allowance or unlimited, owner cap). Lowering only blocks NEW stores.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

type Grant = { grantedLimit: number; updatedAt: Date; id: string };
const h = vi.hoisted(() => ({
  grants: [] as Array<{ grantedLimit: number; updatedAt: Date; id: string }>,
  owned: 0,
  maxStores: 1 as number | null,
  provision: vi.fn(),
  writes: vi.fn(),
}));
const OWNER = '11111111-1111-4111-8111-111111111111';

vi.mock('@ebda/database', async () => {
  const real = await vi.importActual<typeof import('@ebda/database')>('@ebda/database');
  return {
    ...real,
    withUser: async (_u: string, fn: (tx: unknown) => unknown) =>
      fn({
        trustRequest: {
          findMany: async ({
            orderBy,
            take,
          }: {
            orderBy: Array<Record<string, string>>;
            take: number;
          }) => {
            expect(orderBy[0]).toEqual({ updatedAt: 'desc' });
            return [...h.grants]
              .sort(
                (a, b) => b.updatedAt.getTime() - a.updatedAt.getTime() || (a.id < b.id ? 1 : -1)
              )
              .slice(0, take);
          },
          create: h.writes,
          updateMany: h.writes,
          delete: h.writes,
          deleteMany: h.writes,
        },
        store: { count: async () => h.owned, delete: h.writes, update: h.writes },
      }),
  };
});
vi.mock('@api/services/platform/access-d1', () => ({
  onAccessD1: async () => true,
  ownedStoreIdsD1: async () => Array.from({ length: h.owned }, (_, i) => `s${i}`),
}));
vi.mock('@api/lib/identity-client', () => ({
  getAccountState: async () => ({
    id: OWNER,
    status: 'active',
    role: 'store_admin',
    email: 'o@example.com',
    firstName: 'O',
    lastName: 'W',
    emailVerified: true,
    phone: null,
  }),
}));
vi.mock('@api/lib/store-create-do', () => ({
  countOwnerStores: async () => h.owned,
  ownerStores: async () =>
    Array.from({ length: h.owned }, (_, i) => ({
      id: `s${i}`,
      createdAt: new Date(2026, 0, i + 1),
    })),
  storeCreateOnDo: () => true,
}));
vi.mock('@api/services/plan-entitlements', async () => {
  const real = await vi.importActual<typeof import('@api/services/plan-entitlements')>(
    '@api/services/plan-entitlements'
  );
  return {
    ...real,
    getEntitlements: async () => ({ planCode: 'plan-x', limits: { maxStores: h.maxStores } }),
  };
});
vi.mock('@api/services/billing/subscription-billing.service', () => ({
  getSubscriptionBillingState: vi.fn(),
  loadPayablePlan: async () => ({ plan: { isPublic: true } }),
}));
vi.mock('@api/services/store-creation-limit', () => ({
  assertStoreCreationBudget: async () => undefined,
  withStoreCreationLock: (_o: string, fn: () => unknown) => fn(),
}));
vi.mock('@api/services/provisioning.service', () => ({
  ProvisioningService: { provisionStore: h.provision },
}));

beforeEach(() => {
  h.grants = [];
  h.owned = 0;
  h.maxStores = 1;
  h.provision.mockReset().mockRejectedValue(new Error('PROVISIONED'));
  h.writes.mockReset();
});

const grant = (n: number, ageMs = 0, id = `g${n}`): Grant => ({
  grantedLimit: n,
  updatedAt: new Date(Date.now() - ageMs),
  id,
});

async function create() {
  const { OnboardingService } = await import('@api/services/onboarding.service');
  vi.spyOn(OnboardingService, 'checkSlug').mockResolvedValue({
    available: true,
    slug: 'next-store',
  } as never);
  return OnboardingService.createStore({ userId: OWNER }, { name: 'Next', slug: 'next-store' });
}
/** What the DO store-creation gate is told the owner may hold (min(plan allowance, owner cap)). */
const doCap = () => h.provision.mock.calls[0][0].maxOwnedStores as number;

describe('a staff grant never lifts the paid plan allowance', () => {
  it('plan of 1 store, no grant: the 2nd store is a plan-limit upgrade prompt', async () => {
    h.maxStores = 1;
    h.owned = 1;
    await expect(create()).rejects.toMatchObject({
      statusCode: 402,
      details: expect.objectContaining({
        limitKey: 'maxStores',
        limit: 1,
        upgradeTo: expect.anything(),
      }),
    });
    expect(h.provision).not.toHaveBeenCalled();
  });
  it('plan of 1 store, granted 10: still the upgrade prompt, still 1', async () => {
    h.maxStores = 1;
    h.owned = 1;
    h.grants = [grant(10)];
    await expect(create()).rejects.toMatchObject({
      statusCode: 402,
      details: expect.objectContaining({ limitKey: 'maxStores', limit: 1 }),
    });
    expect(h.provision).not.toHaveBeenCalled();
  });
  it('plan of 1 store, granted 10, first store: the DO gate is told 1', async () => {
    h.maxStores = 1;
    h.owned = 0;
    h.grants = [grant(10)];
    await expect(create()).rejects.toThrow('PROVISIONED');
    expect(doCap()).toBe(1);
  });
});

describe('effective limit = min(plan allowance or unlimited, owner cap)', () => {
  it('plan of 10, no grant: the abuse cap of 3 applies', async () => {
    h.maxStores = 10;
    h.owned = 3;
    await expect(create()).rejects.toMatchObject({ code: 'STORE_LIMIT_REACHED', statusCode: 409 });
    h.owned = 2;
    await expect(create()).rejects.toThrow('PROVISIONED');
    expect(doCap()).toBe(3);
  });
  it('plan of 10, granted 6: a 4th store is allowed and the cap is 6', async () => {
    h.maxStores = 10;
    h.owned = 5;
    h.grants = [grant(6)];
    await expect(create()).rejects.toThrow('PROVISIONED');
    expect(doCap()).toBe(6);
    h.provision.mockClear();
    h.owned = 6;
    await expect(create()).rejects.toMatchObject({ code: 'STORE_LIMIT_REACHED' });
  });
  it('plan of 10, granted 15: the plan allowance (10) still caps it', async () => {
    h.maxStores = 10;
    h.owned = 9;
    h.grants = [grant(15)];
    await expect(create()).rejects.toThrow('PROVISIONED');
    expect(doCap()).toBe(10);
    h.owned = 10;
    await expect(create()).rejects.toMatchObject({ statusCode: 402 });
  });
  it('unlimited plan, granted 6: the cap is 6; no grant: 3', async () => {
    h.maxStores = null;
    h.owned = 5;
    h.grants = [grant(6)];
    await expect(create()).rejects.toThrow('PROVISIONED');
    expect(doCap()).toBe(6);
    h.provision.mockClear();
    h.grants = [];
    h.owned = 2;
    await expect(create()).rejects.toThrow('PROVISIONED');
    expect(doCap()).toBe(3);
  });
});

describe('grants are revisable: the LATEST decision is the cap', () => {
  it('ownerStoreLimit: newest wins whether it raises or lowers; none = 3', async () => {
    const { ownerStoreLimit } = await import('@api/services/owner-store-limit');
    expect(await ownerStoreLimit(OWNER)).toBe(3);
    h.grants = [grant(12, 9000, 'a'), grant(5, 1000, 'b')];
    expect(await ownerStoreLimit(OWNER)).toBe(5); // lowered from 12
    h.grants = [grant(5, 9000, 'a'), grant(12, 1000, 'b')];
    expect(await ownerStoreLimit(OWNER)).toBe(12); // raised again
  });
  it('lowering to 3 blocks NEW stores and touches no existing store', async () => {
    h.maxStores = null;
    h.owned = 5; // created while the cap was 6
    h.grants = [grant(6, 9000, 'a'), grant(3, 1000, 'b')];
    await expect(create()).rejects.toMatchObject({ code: 'STORE_LIMIT_REACHED', statusCode: 409 });
    expect(h.provision).not.toHaveBeenCalled();
    expect(h.writes).not.toHaveBeenCalled(); // no delete / update of any store or request
  });
});
