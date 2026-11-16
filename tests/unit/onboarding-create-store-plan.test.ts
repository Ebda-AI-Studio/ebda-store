/**
 * Self-serve store creation under the locked pricing:
 *   - the FIRST store starts the 14-day Growth trial (provisioned as `professional`);
 *   - a SECOND store is plan-gated (1/1/3) and, when allowed, rides the owner's
 *     Business plan with NO second trial (stops trial farming);
 *   - the plan gate runs inside the per-owner lock, before any provisioning.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const m = vi.hoisted(() => ({
  count: vi.fn(),
  findUnique: vi.fn(),
  provision: vi.fn(),
  gate: vi.fn(),
  budget: vi.fn(),
  order: [] as string[],
}));

vi.mock('@ebda/database', () => ({
  prisma: {},
  Prisma: { PrismaClientKnownRequestError: class extends Error {} },
  withUser: async (_id: string, fn: (tx: unknown) => unknown) =>
    fn({
      // `stores` is under RLS: the owner's store count is read as that owner.
      store: { count: m.count },
      // the owner's store-limit grant (owner-store-limit.ts): none here, so the default cap of 3 applies
      trustRequest: { findMany: async () => [] },
      user: {
        findUnique: async () => ({
          email: 'o@x.com',
          firstName: 'Omar',
          lastName: 'A',
          storeId: null,
        }),
      },
    }),
}));
// The slug probe is the `ebda_store_id_by_slug` definer (m.findUnique: null = slug is free).
vi.mock('@api/lib/definer', () => ({ storeIdBySlug: m.findUnique }));
vi.mock('@api/services/provisioning.service', () => ({
  ProvisioningService: { provisionStore: m.provision },
}));
vi.mock('@api/services/store.service', () => ({ bustStoreCaches: vi.fn() }));
vi.mock('@api/services/setup-guide.service', () => ({ SetupGuideService: {} }));
vi.mock('@api/lib/store-scoped-read', () => ({ readInStoreContext: vi.fn() }));
vi.mock('@api/services/plan-limit.service', () => ({ assertOwnerMayCreateStore: m.gate }));
// Signup funnel: the chosen plan is validated (payable + public) before anything is created.
vi.mock('@api/services/billing/subscription-billing.service', () => ({
  loadPayablePlan: vi.fn(async (code: string) => ({
    plan: { code, isPublic: true },
    price: 349000,
  })),
  getSubscriptionBillingState: vi.fn(),
}));
vi.mock('@api/services/billing/go-live-gate', () => ({ assertStoreMayGoLive: vi.fn() }));
vi.mock('@api/services/store-creation-limit', () => ({
  assertStoreCreationBudget: m.budget,
  withStoreCreationLock: (_o: string, fn: () => unknown) => {
    m.order.push('lock');
    return fn();
  },
}));

import { OnboardingService } from '@api/services/onboarding.service';

const input = { name: 'Shop', slug: 'my-shop' };

beforeEach(() => {
  for (const f of [m.count, m.findUnique, m.provision, m.gate, m.budget]) f.mockReset();
  m.order.length = 0;
  m.findUnique.mockResolvedValue(null);
  m.provision.mockResolvedValue({ store: { id: 'new' } });
});

describe('OnboardingService.createStore — locked pricing', () => {
  it('first store: Growth trial (professional + growthTrial), gate consulted', async () => {
    m.count.mockResolvedValue(0);
    await OnboardingService.createStore({ userId: 'u1' }, input);
    expect(m.gate).toHaveBeenCalledWith('u1');
    expect(m.provision).toHaveBeenCalledWith(
      expect.objectContaining({
        plan: 'professional',
        growthTrial: true,
        status: 'inactive',
        trialChoice: { planCode: 'growth', interval: 'monthly' },
      })
    );
  });

  it('second store (owner already allowed by the gate): Business tier, NO second trial', async () => {
    m.count.mockResolvedValue(1);
    await OnboardingService.createStore({ userId: 'u1' }, input);
    expect(m.provision).toHaveBeenCalledWith(
      expect.objectContaining({ plan: 'enterprise', growthTrial: false })
    );
  });

  it('a plan refusal (Basic/Growth owner) blocks provisioning entirely', async () => {
    m.count.mockResolvedValue(1);
    const refusal = Object.assign(new Error('402'), { statusCode: 402 });
    m.gate.mockRejectedValueOnce(refusal);
    await expect(OnboardingService.createStore({ userId: 'u1' }, input)).rejects.toBe(refusal);
    expect(m.provision).not.toHaveBeenCalled();
  });

  it('super_admin support claims are not plan-bound', async () => {
    m.count.mockResolvedValue(0);
    await OnboardingService.createStore({ userId: 'u1', isSuperAdmin: true }, input);
    expect(m.gate).not.toHaveBeenCalled();
    expect(m.order).not.toContain('lock');
  });
});
