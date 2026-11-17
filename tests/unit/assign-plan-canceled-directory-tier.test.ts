/**
 * #835: the super-admin `PUT /admin/stores/:id/subscription` path (planService.assignPlan) is the code path that can
 * write a canceled subscription that still NAMES a paid plan. It used to set `stores.plan` to that plan's tier
 * (canceled Growth -> `professional`), the exact prod shape of `qa-merchant-test`. The directory tier now follows the
 * entitlement: canceled = free.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({ storeUpdate: vi.fn(), upsert: vi.fn() }));

vi.mock('@ebda/database', () => ({
  prisma: {
    plan: { findUnique: async () => ({ code: 'growth', featureTier: 'professional' }) },
  },
  withStore: async (_id: string, fn: (tx: unknown) => unknown) =>
    fn({ storeSubscription: { upsert: h.upsert } }),
}));
vi.mock('@api/lib/repo-factory', () => ({
  storeDb: async () => ({
    store: { findUnique: async () => ({ id: 's', slug: 's', domain: null }) },
  }),
  storeUpdate: h.storeUpdate,
}));
vi.mock('@api/services/feature.service', () => ({ featureService: { invalidateCache: vi.fn() } }));
vi.mock('@api/services/store.service', () => ({ bustStoreCaches: vi.fn() }));
vi.mock('@api/services/billing/account.service', () => ({ reconcileStoreAccess: vi.fn() }));
vi.mock('@api/services/staff-invite.service', () => ({
  expireInvitesBeyondSeats: vi.fn().mockResolvedValue(undefined),
}));

import { planService } from '@api/services/plan.service';

const STORE = '11111111-1111-4111-8111-111111111111';

beforeEach(() => {
  h.storeUpdate.mockReset();
  h.upsert.mockReset();
});

describe('assignPlan keeps stores.plan on the ENTITLED tier', () => {
  it('growth + canceled: stores.plan = free (not professional)', async () => {
    await planService.assignPlan(STORE, { planCode: 'growth', status: 'canceled' });
    expect(h.storeUpdate).toHaveBeenCalledWith(expect.anything(), {
      where: { id: STORE },
      data: { plan: 'free' },
    });
  });

  it('control: growth + active: stores.plan = professional', async () => {
    await planService.assignPlan(STORE, { planCode: 'growth', status: 'active' });
    expect(h.storeUpdate).toHaveBeenCalledWith(expect.anything(), {
      where: { id: STORE },
      data: { plan: 'professional' },
    });
  });
});
