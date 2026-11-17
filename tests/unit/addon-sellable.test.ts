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

describe('approved prices and messaging', () => {
  it('customer_intelligence is never sold: the owner switches it on any plan (Ruling CI-10)', async () => {
    // holds even once Business carries it (#847): the exclusion is explicit, not a side effect of the baseline
    const { NEVER_SOLD_FEATURES } = await import('@ebda/shared');
    expect(NEVER_SOLD_FEATURES.has('customer_intelligence')).toBe(true);
    expect(sold).not.toContain('customer_intelligence');
    expect(addonSkuForFeature('customer_intelligence')).toBeNull();
    for (const plan of ['starter', 'professional'])
      expect(canBuyFeatureOnPlan(plan, 'customer_intelligence')).toBe(false);
    expect(ADDON_CATALOG['feature:customer_intelligence']).toBeUndefined();
  });

  it('sms and whatsapp are never sold, and sms is hidden from every plan, gate and marketing surface', () => {
    expect(sold).not.toContain('sms');
    expect(sold).not.toContain('whatsapp');
    expect(addonSkuForFeature('sms')).toBeNull();
    for (const plan of ['starter', 'professional', 'enterprise', 'free']) {
      expect(canBuyFeatureOnPlan(plan, 'sms')).toBe(false);
    }
    expect(FEATURE_REGISTRY.sms.hidden).toBe(true);
    expect(Object.values(ADDON_CATALOG).some(i => i.featureKey === 'sms')).toBe(false);
  });

  it('every approved price belongs to a feature that is actually sellable (no stale price), and the catalogue uses it', async () => {
    const { ADDON_FEATURE_PRICE_MINOR, addonFeaturePriceMinor } = await import('@ebda/shared');
    for (const [k, v] of Object.entries(ADDON_FEATURE_PRICE_MINOR)) {
      // priced ahead of time (a feature Business does not hold yet, or one still hidden) is fine; priced AND held by
      // Business AND not sold is a stale price
      const heldByBusiness = (PLAN_BASELINE.enterprise as readonly string[]).includes(k);
      if (heldByBusiness && !FEATURE_REGISTRY[k as FeatureKey].hidden)
        expect(sold).toContain(k as FeatureKey);
      expect(Number.isSafeInteger(v) && (v as number) > 0).toBe(true);
      if (ADDON_CATALOG[`feature:${k}`]) expect(ADDON_CATALOG[`feature:${k}`].priceMinor).toBe(v);
    }
    for (const [k, minor] of [
      ['bundles', 14900],
      ['remove_branding', 24900],
      ['merchant_mcp', 19900],
      ['merchant_mcp_write', 9900],
      ['b2b.wholesale', 39900],
    ] as const)
      expect(addonFeaturePriceMinor(k)).toBe(minor);
    expect(ADDON_CATALOG['feature:loyalty'].priceMinor).toBe(24900);
    expect(ADDON_CATALOG['feature:floating_widget'].priceMinor).toBe(7900);
    expect(addonFeaturePriceMinor('loyalty')).toBe(24900);
  });

  it('a sellable feature with no approved price keeps the placeholder, never a guessed price', async () => {
    const { ADDON_FEATURE_PRICE_MINOR, ADDON_PLACEHOLDER_PRICE_MINOR } =
      await import('@ebda/shared');
    for (const k of sold) {
      if (!(k in ADDON_FEATURE_PRICE_MINOR))
        expect(ADDON_CATALOG[`feature:${k}`].priceMinor).toBe(ADDON_PLACEHOLDER_PRICE_MINOR);
    }
  });
});
