/**
 * The self-serve store limit is MAX_SELF_SERVE_STORES_PER_OWNER (3) per owner. Staff can grant one owner more by
 * RESOLVING their store-limit request with a new limit: an owner with a granted 5 can create a 4th store, an owner
 * without a grant gets STORE_LIMIT_REACHED.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({ granted: null as number | null }));
const OWNER = '11111111-1111-4111-8111-111111111111';

vi.mock('@ebda/database', async () => {
  const real = await vi.importActual<typeof import('@ebda/database')>('@ebda/database');
  return {
    ...real,
    withUser: async (_u: string, fn: (tx: unknown) => unknown) =>
      fn({
        trustRequest: {
          findMany: async () => (h.granted === null ? [] : [{ grantedLimit: h.granted }]),
        },
      }),
  };
});
vi.mock('@api/services/platform/access-d1', () => ({
  onAccessD1: async () => true,
  ownedStoreIdsD1: async () => ['s1', 's2', 's3'],
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
  countOwnerStores: async (_o: string, fallback: () => Promise<number>) => fallback(),
  storeCreateOnDo: () => false,
}));
// the first step AFTER the limit gate: reaching it proves the gate let the owner through
vi.mock('@api/services/billing/subscription-billing.service', () => ({
  getSubscriptionBillingState: vi.fn(),
  loadPayablePlan: async () => {
    throw Object.assign(new Error('PAST_THE_LIMIT_GATE'), { code: 'PAST_GATE' });
  },
}));

beforeEach(() => {
  h.granted = null;
});

const create = async () => {
  const { OnboardingService } = await import('@api/services/onboarding.service');
  return OnboardingService.createStore({ userId: OWNER }, { name: 'Fourth', slug: 'fourth-store' });
};

describe('owner store limit', () => {
  it('without a grant the 4th store is refused: STORE_LIMIT_REACHED', async () => {
    await expect(create()).rejects.toMatchObject({ code: 'STORE_LIMIT_REACHED', statusCode: 409 });
  });
  it('with a granted limit of 5 the owner passes the gate for a 4th store', async () => {
    h.granted = 5;
    await expect(create()).rejects.toMatchObject({ code: 'PAST_GATE' });
  });
  it('a granted limit equal to the 3 already owned still refuses (the limit is the count, not count + 1)', async () => {
    h.granted = 3;
    await expect(create()).rejects.toMatchObject({ code: 'STORE_LIMIT_REACHED' });
  });
  it('ownerStoreLimit: the grant, else the constant; never below the constant', async () => {
    const { ownerStoreLimit, MAX_SELF_SERVE_STORES_PER_OWNER } =
      await import('@api/services/owner-store-limit');
    expect(await ownerStoreLimit(OWNER)).toBe(MAX_SELF_SERVE_STORES_PER_OWNER);
    h.granted = 7;
    expect(await ownerStoreLimit(OWNER)).toBe(7);
    h.granted = 2;
    expect(await ownerStoreLimit(OWNER)).toBe(MAX_SELF_SERVE_STORES_PER_OWNER);
  });
});
