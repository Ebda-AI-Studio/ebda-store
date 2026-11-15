/**
 * Sellable set = (Business baseline) minus (the store's own plan baseline), computed from PLAN_BASELINE, never hand-listed.
 * A Business store is never offered a feature; Free picks a plan; Basic and Growth buy only what their plan lacks.
 */
import { describe, expect, it } from 'vitest';
import {
  FEATURE_REGISTRY,
  PLAN_BASELINE,
  addonFeatureKeys,
  addonSkuForFeature,
  canBuyFeatureOnPlan,
  type FeatureKey,
} from '@ebda/shared';
import { ADDON_CATALOG } from '@api/services/billing/addon-catalog';

const sold = addonFeatureKeys();

describe('computed sellable set', () => {
  it('is exactly the Business baseline minus the never-sold and hidden features', () => {
    const expected = (PLAN_BASELINE.enterprise as readonly FeatureKey[]).filter(
      k => !FEATURE_REGISTRY[k].hidden && k !== 'whatsapp' && k !== 'agent_checkout_open_writes'
    );
    expect([...sold].sort()).toEqual([...expected].sort());
  });

  it('the catalogue sells exactly that set (one sku per feature, plus the AI top-ups)', () => {
    const features = Object.values(ADDON_CATALOG)
      .filter(i => i.kind === 'feature')
      .map(i => i.featureKey)
      .sort();
    expect(features).toEqual([...sold].sort());
    expect(Object.values(ADDON_CATALOG).some(i => i.kind === 'ai_topup')).toBe(true);
  });

  it('a Business store can buy NO feature, a Free store none (it picks a plan first)', () => {
    for (const k of sold) {
      expect(canBuyFeatureOnPlan('enterprise', k)).toBe(false);
      expect(canBuyFeatureOnPlan('free', k)).toBe(false);
    }
  });

  it('Basic and Growth can buy exactly what their own plan lacks', () => {
    for (const plan of ['starter', 'professional'] as const) {
      const own = new Set<string>(PLAN_BASELINE[plan]);
      for (const k of sold) expect(canBuyFeatureOnPlan(plan, k)).toBe(!own.has(k));
    }
  });

  it('a feature the plan already has is never sold to it; the sku helper agrees with the set', () => {
    expect(canBuyFeatureOnPlan('professional', 'loyalty')).toBe(
      !(PLAN_BASELINE.professional as readonly string[]).includes('loyalty')
    );
    for (const k of sold) expect(addonSkuForFeature(k)).toBe(`feature:${k}`);
    expect(addonSkuForFeature('whatsapp')).toBeNull();
    expect(addonSkuForFeature('agent_checkout_open_writes')).toBeNull();
  });
});
