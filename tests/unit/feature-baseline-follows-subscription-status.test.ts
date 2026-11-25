/**
 * #835 (money-abuse audit S3, P1): the feature baseline follows the subscription's ENTITLEMENT, not the `stores.plan`
 * directory column. Production had `qa-merchant-test` with `status=canceled`, `plan_code=growth` and
 * `stores.plan=professional`: getEntitlements already gave it the free limits, but FeatureService read
 * PLAN_BASELINE['professional'] and kept the whole Growth baseline on (loyalty, accounting, email campaigns...).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@api/services/redis.service', () => ({
  redis: { get: vi.fn().mockResolvedValue(null), set: vi.fn(), delete: vi.fn() },
}));

const h = vi.hoisted(() => ({
  storePlan: 'professional' as string,
  sub: null as null | { planCode: string; status: string },
}));

vi.mock('@ebda/database', () => ({
  prisma: {},
  Prisma: {},
  withMoneyTx: vi.fn(),
  withStore: vi.fn(async (_storeId: string, fn: (tx: unknown) => unknown) =>
    fn({
      store: { findUnique: async () => ({ plan: h.storePlan }) },
      storeFeature: { findMany: async () => [] },
      billingEvent: { findMany: async () => [] }, // no running add-on (activeAddons)
      storeSubscription: { findUnique: async () => h.sub },
      // no plans row: the seed for the effective code decides (same as a fresh D1)
      plan: { findUnique: async () => null },
    })
  ),
}));

import { featureService } from '@api/services/feature.service';

let n = 0;
const fresh = () => `store-835-${++n}`; // a new id per case: the in-flight map is keyed on it

beforeEach(() => {
  h.storePlan = 'professional';
  h.sub = null;
});

describe('feature baseline follows the subscription status (#835)', () => {
  it('canceled Growth with stores.plan=professional: the Growth baseline is OFF (free baseline)', async () => {
    h.sub = { planCode: 'growth', status: 'canceled' };
    const f = await featureService.getStoreFeatures(fresh());
    expect(f.loyalty).toBe(false);
    expect(f.email_campaigns).toBe(false);
  });

  it('control: active Growth with the same stores.plan keeps the Growth baseline', async () => {
    h.sub = { planCode: 'growth', status: 'active' };
    const f = await featureService.getStoreFeatures(fresh());
    expect(f.loyalty).toBe(true);
  });

  it('a stale stores.plan never RAISES the baseline: active Basic on stores.plan=professional gets Basic', async () => {
    h.sub = { planCode: 'basic', status: 'active' };
    const f = await featureService.getStoreFeatures(fresh());
    expect(f.loyalty).toBe(false);
  });

  it('no subscription row: the legacy stores.plan still decides (pre-engine safety net unchanged)', async () => {
    h.sub = null;
    const f = await featureService.getStoreFeatures(fresh());
    expect(f.loyalty).toBe(true);
  });
});
