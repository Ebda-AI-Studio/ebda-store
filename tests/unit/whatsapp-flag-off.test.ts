/**
 * WHATSAPP-OFF-1 (2026-10-14): the `whatsapp` feature (the separate Ebda Chat
 * product, wa.ebda.app; the legacy in-Store bridge was deleted by WA-LEGACY-1) is
 * flagged OFF for every store. No plan baseline contains the key, the registry
 * entry is hidden, and only a super-admin StoreFeature override turns it on for
 * one store.
 *
 * Covers: PLAN_BASELINE / registry shape, FeatureService resolution for every
 * plan (including a plan whose limits say `whatsappAutomation: true`), and the
 * per-store override path (both directions).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@api/services/billing/addon-grant', () => ({ activeAddons: async () => [] }));
vi.mock('@api/services/redis.service', () => ({
  redis: { get: vi.fn().mockResolvedValue(null), set: vi.fn(), delete: vi.fn() },
}));

const { findUnique, findMany, planFindUnique, withRlsBypass } = vi.hoisted(() => {
  const findUnique = vi.fn();
  const findMany = vi.fn();
  const planFindUnique = vi.fn();
  return {
    findUnique,
    findMany,
    planFindUnique,
    withRlsBypass: vi.fn(async (_storeId: string, fn: (tx: unknown) => unknown) =>
      fn({
        store: { findUnique },
        storeFeature: { findMany },
        storeSubscription: { findUnique: vi.fn().mockResolvedValue(null) },
        plan: { findUnique: planFindUnique },
      })
    ),
  };
});

vi.mock('@ebda/database', () => ({
  prisma: {},
  Prisma: {},
  withMoneyTx: vi.fn(),
  withStore: withRlsBypass,
}));

import { FEATURE_REGISTRY, getVisibleFeatures } from '../../packages/shared/src/features';
import { DEFAULT_PLAN_SEEDS } from '../../packages/shared/src/schemas/plan-limits';
import { PLAN_BASELINE, lowestPlanForFeature } from '../../packages/shared/src/plan-baselines';
import { featureService } from '@api/services/feature.service';

const PLANS = Object.keys(PLAN_BASELINE) as Array<keyof typeof PLAN_BASELINE>;

describe('WHATSAPP-OFF-1 — baseline + registry', () => {
  it('whatsapp is in NO plan baseline', () => {
    expect(PLANS.length).toBeGreaterThan(0);
    for (const plan of PLANS) {
      expect(PLAN_BASELINE[plan], plan).not.toContain('whatsapp');
    }
    expect(lowestPlanForFeature('whatsapp')).toBeNull();
  });

  it('the registry entry is hidden (not launched) but the key stays valid', () => {
    expect(FEATURE_REGISTRY.whatsapp.hidden).toBe(true);
    expect(getVisibleFeatures().map(f => f.key)).not.toContain('whatsapp');
  });
});

describe('WHATSAPP-OFF-1 — FeatureService resolution', () => {
  beforeEach(() => {
    (featureService as unknown as { connectionOutageAt: number }).connectionOutageAt = 0;
    findUnique.mockReset();
    findMany.mockReset().mockResolvedValue([]);
    planFindUnique.mockReset().mockResolvedValue(null); // -> seed limits
  });

  it.each(PLANS)('plan %s resolves whatsapp OFF with no override', async plan => {
    findUnique.mockResolvedValue({ plan });
    await expect(featureService.isFeatureEnabled(`store-off-${plan}`, 'whatsapp')).resolves.toBe(
      false
    );
  });

  it.each(PLANS)('plan %s: a StoreFeature override (enabled=true) turns it ON', async plan => {
    findUnique.mockResolvedValue({ plan });
    findMany.mockResolvedValue([{ featureKey: 'whatsapp', enabled: true }]);
    await expect(featureService.isFeatureEnabled(`store-on-${plan}`, 'whatsapp')).resolves.toBe(
      true
    );
  });

  it('a plan whose limits say whatsappAutomation:true does NOT turn it on (limit no longer feeds the flag)', async () => {
    const seed = DEFAULT_PLAN_SEEDS.find(p => p.code === 'comped')!;
    planFindUnique.mockResolvedValue({
      code: seed.code,
      nameEn: seed.nameEn,
      nameAr: seed.nameAr,
      limits: { ...seed.limits, whatsappAutomation: true },
    });
    findUnique.mockResolvedValue({ plan: 'enterprise' });
    await expect(featureService.isFeatureEnabled('store-limit-true', 'whatsapp')).resolves.toBe(
      false
    );
    // ...while the sibling automation flag still flows from the same limits blob.
    planFindUnique.mockResolvedValue({
      code: seed.code,
      nameEn: seed.nameEn,
      nameAr: seed.nameAr,
      limits: { ...seed.limits, abandonedCartAutomation: true },
    });
    await expect(
      featureService.isFeatureEnabled('store-limit-true-2', 'abandoned_cart')
    ).resolves.toBe(true);
  });

  it('an explicit enabled=false override keeps it OFF', async () => {
    findUnique.mockResolvedValue({ plan: 'enterprise' });
    findMany.mockResolvedValue([{ featureKey: 'whatsapp', enabled: false }]);
    await expect(featureService.isFeatureEnabled('store-explicit-off', 'whatsapp')).resolves.toBe(
      false
    );
  });

  it('the override is per store: another store on the same plan stays OFF', async () => {
    findUnique.mockResolvedValue({ plan: 'professional' });
    findMany.mockResolvedValueOnce([{ featureKey: 'whatsapp', enabled: true }]);
    await expect(featureService.isFeatureEnabled('store-a', 'whatsapp')).resolves.toBe(true);
    findMany.mockResolvedValue([]);
    await expect(featureService.isFeatureEnabled('store-b', 'whatsapp')).resolves.toBe(false);
  });

  it('other baseline features are untouched (coupons still ON for starter)', async () => {
    findUnique.mockResolvedValue({ plan: 'starter' });
    await expect(featureService.isFeatureEnabled('store-other', 'coupons')).resolves.toBe(true);
  });
});
