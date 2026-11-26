/**
 * Ruling BIZ-ALL-5, decision level: for a Durable Object store the plan used by getEntitlements AND by the feature gate comes from
 * D1, never from the DO mirror. Mirror=enterprise + D1=starter (a downgrade) must DENY a Business-only feature (no fail-open);
 * mirror=starter + D1=enterprise must ALLOW it. Real readStorePlan / FeatureService / getEntitlements / requireFeature run here;
 * only storage and the request scope are faked.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({ mirror: 'starter', d1: 'enterprise' }));

vi.mock('@ebda/database', () => ({
  prisma: {},
  Prisma: {},
  withMoneyTx: vi.fn(),
  withStore: async (_id: string, fn: (tx: unknown) => unknown) =>
    fn({
      storeFeature: { findMany: async () => [] },
      storeSubscription: { findUnique: async () => null },
      plan: { findUnique: async () => null },
      store: { findUnique: async () => ({ plan: h.mirror }) },
    }),
}));
vi.mock('@api/services/redis.service', () => ({
  redis: { get: vi.fn(), set: vi.fn(), delete: vi.fn() },
}));
vi.mock('@api/services/store.service', () => ({ bustStoreCaches: vi.fn() }));
vi.mock('@api/lib/public-cache', () => ({ invalidateStoreProductCaches: vi.fn() }));
vi.mock('@api/utils/store-helpers', () => ({ resolvePublicStoreId: vi.fn() }));
vi.mock('@api/lib/repo-factory', () => ({
  storeUpdate: vi.fn(),
  requestPlanMemo: (_id: string, fn: () => Promise<unknown>) => fn(),
  storeRepo: async () => ({
    backend: 'do',
    db: { store: { findUnique: async () => ({ plan: h.mirror }) } },
  }),
}));
vi.mock('@api/lib/platform-db', () => ({
  platformDb: async () => ({
    store: { findUnique: async () => ({ plan: h.d1, deletedAt: null }) },
    storeSubscription: { findUnique: async () => null },
    plan: { findUnique: async () => null },
  }),
}));

import { featureService } from '@api/services/feature.service';
import { getEntitlements } from '@api/services/plan-entitlements';
import { requireFeature } from '@api/middleware/feature-gate';

const S = 'store-do-1';
async function gate(): Promise<number | 'next'> {
  let out: number | 'next' = 'next';
  const res: any = { status: (c: number) => ((out = c), res), json: () => res };
  await requireFeature('floating_widget')(
    { params: { storeId: S }, user: { role: 'store_admin' }, path: '/x' } as any,
    res,
    () => {
      out = 'next';
    }
  );
  return out;
}

describe('a DO store whose mirror disagrees with D1', () => {
  beforeEach(() => vi.clearAllMocks());

  it('downgrade: mirror enterprise, D1 starter -> entitlements AND the feature gate deny Business-only', async () => {
    h.mirror = 'enterprise';
    h.d1 = 'starter';
    const e = await getEntitlements(S);
    expect(e?.planCode).toBe('basic');
    expect(e?.limits.wholesalePricing).toBe(false);
    expect(await featureService.isFeatureEnabled(S, 'floating_widget')).toBe(false);
    expect(await gate()).toBe(403);
  });

  it('upgrade: mirror starter, D1 enterprise -> entitlements AND the feature gate allow it', async () => {
    h.mirror = 'starter';
    h.d1 = 'enterprise';
    const e = await getEntitlements(S);
    expect(e?.planCode).toBe('business');
    expect(e?.limits.wholesalePricing).toBe(true);
    expect(await featureService.isFeatureEnabled(S, 'floating_widget')).toBe(true);
    expect(await gate()).toBe('next');
  });
});
