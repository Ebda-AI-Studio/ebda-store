import { describe, it, expect } from 'vitest';
import {
  PLAN_BASELINE,
  STORE_PLANS,
  PLAN_LABELS,
  getBaselineFeatures,
  isInBaseline,
  lowestPlanForFeature,
  publicPlanLabelForFeature,
  publicPlanForStorePlan,
  upgradeTargetForDisabledFeature,
  BUSINESS_BASELINE_EXCLUSIONS,
  type StorePlan,
} from '../plan-baselines';
import { FEATURE_KEYS_ARRAY, FEATURE_REGISTRY, type FeatureKey } from '../features';

describe('PLAN_BASELINE', () => {
  it('every plan in STORE_PLANS has a baseline array', () => {
    for (const plan of STORE_PLANS) {
      expect(PLAN_BASELINE[plan]).toBeDefined();
      expect(Array.isArray(PLAN_BASELINE[plan])).toBe(true);
    }
  });

  it('every key in every baseline exists in FEATURE_REGISTRY (no typos)', () => {
    for (const plan of STORE_PLANS) {
      for (const key of PLAN_BASELINE[plan]) {
        expect(FEATURE_REGISTRY[key as FeatureKey]).toBeDefined();
      }
    }
  });

  it('every PLAN_LABELS entry covers a real plan', () => {
    for (const plan of STORE_PLANS) {
      expect(PLAN_LABELS[plan]).toBeDefined();
      expect(PLAN_LABELS[plan].en.length).toBeGreaterThan(0);
      expect(PLAN_LABELS[plan].ar.length).toBeGreaterThan(0);
    }
  });

  // Strict superset invariant: paid plans never DROP a feature as you go up.
  // (The `free` plan is a stripped fallback, so the invariant starts at starter.)
  it('professional is a superset of starter', () => {
    const starter = new Set(PLAN_BASELINE.starter);
    for (const key of starter) {
      expect(PLAN_BASELINE.professional).toContain(key);
    }
  });

  it('enterprise is a superset of professional', () => {
    const pro = new Set(PLAN_BASELINE.professional);
    for (const key of pro) {
      expect(PLAN_BASELINE.enterprise).toContain(key);
    }
  });

  // Specific landmark features — these are the ones the contract +
  // proposal templates list, so a regression breaks customer documents.
  it('starter includes basic inventory but NOT backorder', () => {
    expect(PLAN_BASELINE.starter).toContain('inventory.basic');
    expect(PLAN_BASELINE.starter).not.toContain('inventory.backorder');
    expect(PLAN_BASELINE.starter).not.toContain('inventory.multi_warehouse');
  });

  it('professional adds stock alerts + backorder + basic accounting + loyalty', () => {
    expect(PLAN_BASELINE.professional).toContain('inventory.stock_alerts');
    expect(PLAN_BASELINE.professional).toContain('inventory.backorder');
    expect(PLAN_BASELINE.professional).toContain('accounting.basic');
    expect(PLAN_BASELINE.professional).toContain('loyalty');
  });

  it('professional does NOT include multi-warehouse (enterprise-only)', () => {
    expect(PLAN_BASELINE.professional).not.toContain('inventory.multi_warehouse');
  });

  // AI-first policy (2026-07-21): every AI capability is available on every paid
  // plan. AI is the product's core differentiator — tiering it made the
  // "AI-first product" positioning untrue and left the flagship AI Product Feed
  // disabled on every store. `free` is excluded: it is the lapsed-payment grace
  // state, not a plan anyone buys.
  it('every paid plan includes every AI feature', () => {
    const AI_FEATURES = [
      'agent_feed',
      'upsell_crosssell',
      'accounting.profit_anomaly',
      'bulk_operations',
      'inventory.basic',
    ] as const;

    for (const plan of ['starter', 'professional', 'enterprise'] as const) {
      for (const key of AI_FEATURES) {
        expect(PLAN_BASELINE[plan]).toContain(key);
      }
    }
  });

  it('free does not get AI features (lapsed-payment grace state)', () => {
    expect(PLAN_BASELINE.free).not.toContain('agent_feed');
    expect(PLAN_BASELINE.free).not.toContain('accounting.profit_anomaly');
  });

  // Product feeds (Ruling FEEDS-1): same gate as agent_feed - every paid plan, off on free.
  it('product_feeds is registered and default-ON for all paid plans, off on free', () => {
    expect(FEATURE_KEYS_ARRAY).toContain('product_feeds');
    for (const plan of ['starter', 'professional', 'enterprise'] as const) {
      expect(PLAN_BASELINE[plan]).toContain('product_feeds');
    }
    expect(PLAN_BASELINE.free).not.toContain('product_feeds');
  });

  // Answer-Engine Insights (Task 1, 2026-07-22): default-ON for all paid
  // plans, off on free — mirrors the agent_feed AI-first baseline above.
  it('answer_engine_insights is registered and default-ON for all paid plans, off on free', () => {
    expect(FEATURE_KEYS_ARRAY).toContain('answer_engine_insights');
    expect(FEATURE_REGISTRY.answer_engine_insights.key).toBe('answer_engine_insights');
    expect(PLAN_BASELINE.starter).toContain('answer_engine_insights');
    expect(PLAN_BASELINE.free).not.toContain('answer_engine_insights');
  });

  it('no baseline array contains duplicate keys', () => {
    for (const plan of STORE_PLANS) {
      const arr = PLAN_BASELINE[plan];
      expect(new Set(arr).size).toBe(arr.length);
    }
  });

  it('enterprise includes full inventory + accounting suites + affiliate + sms', () => {
    const full = [
      'inventory.multi_warehouse',
      'inventory.barcode',
      'inventory.purchase_orders',
      'inventory.bulk_adjustments',
      'accounting.tax_reports',
      'accounting.multi_currency',
      'accounting.profit_anomaly',
      'accounting.bank_reconcile',
      'affiliate',
      'sms',
    ] as const;
    for (const key of full) {
      expect(PLAN_BASELINE.enterprise).toContain(key);
    }
  });

  it('free is genuinely stripped (≤5 features)', () => {
    expect(PLAN_BASELINE.free.length).toBeLessThanOrEqual(5);
  });

  it('legacy `inventory` parent flag is only in Business (Ruling BIZ-ALL-1; routes read inventory.*)', () => {
    for (const plan of ['free', 'starter', 'professional'] as const) {
      expect(PLAN_BASELINE[plan]).not.toContain('inventory');
    }
    expect(PLAN_BASELINE.enterprise).toContain('inventory');
  });
});

describe('getBaselineFeatures', () => {
  it('returns a defensive copy', () => {
    const copy = getBaselineFeatures('professional');
    copy.pop();
    // Original baseline should be untouched
    expect(PLAN_BASELINE.professional.length).toBeGreaterThan(copy.length);
  });

  it('returns the same set for the same plan', () => {
    const a = getBaselineFeatures('starter');
    const b = getBaselineFeatures('starter');
    expect(a).toEqual(b);
  });
});

describe('isInBaseline', () => {
  it('starter has inventory.basic but not loyalty', () => {
    expect(isInBaseline('starter', 'inventory.basic')).toBe(true);
    expect(isInBaseline('starter', 'loyalty')).toBe(false);
  });

  it('professional has loyalty', () => {
    expect(isInBaseline('professional', 'loyalty')).toBe(true);
  });

  it('enterprise has affiliate (professional does not)', () => {
    expect(isInBaseline('enterprise', 'affiliate')).toBe(true);
    expect(isInBaseline('professional', 'affiliate')).toBe(false);
  });
});

describe('PLAN_LABELS', () => {
  it('Arabic labels are non-empty for every plan', () => {
    for (const plan of STORE_PLANS) {
      expect(PLAN_LABELS[plan].ar.trim().length).toBeGreaterThan(0);
    }
  });
});

describe('lowestPlanForFeature', () => {
  // coupons is in free baseline (also starter, professional, enterprise)
  it('returns "free" for coupons (first plan that includes it)', () => {
    expect(lowestPlanForFeature('coupons')).toBe('free');
  });

  // loyalty is first introduced in PROFESSIONAL_ADDITIONS
  it('returns "professional" for loyalty', () => {
    expect(lowestPlanForFeature('loyalty')).toBe('professional');
  });

  // affiliate is first introduced in ENTERPRISE_ADDITIONS
  it('returns "enterprise" for affiliate', () => {
    expect(lowestPlanForFeature('affiliate')).toBe('enterprise');
  });

  // inventory.basic is in STARTER_CORE (and also free baseline)
  it('returns "free" for inventory.basic (present in free baseline)', () => {
    // free baseline has inventory.basic per plan-baselines.ts
    expect(lowestPlanForFeature('inventory.basic')).toBe('free');
  });

  // inventory.stock_alerts is in PROFESSIONAL_ADDITIONS only
  it('returns "professional" for inventory.stock_alerts', () => {
    expect(lowestPlanForFeature('inventory.stock_alerts')).toBe('professional');
  });

  // abandoned_cart is in STARTER_CORE
  it('returns "starter" for abandoned_cart', () => {
    expect(lowestPlanForFeature('abandoned_cart')).toBe('starter');
  });

  // Customer wallet (Ruling W-8, 2026-10-29): Growth (professional) and Business (enterprise), never Basic or free.
  it.each(['customer_wallet', 'customer_wallet_checkout'] as const)(
    '%s is in the Growth and Business baselines only',
    key => {
      expect(isInBaseline('free', key)).toBe(false);
      expect(isInBaseline('starter', key)).toBe(false);
      expect(isInBaseline('professional', key)).toBe(true);
      expect(isInBaseline('enterprise', key)).toBe(true);
      expect(lowestPlanForFeature(key)).toBe('professional');
    }
  );
});

// Plan key shape — guard against accidental rename in the type
describe('StorePlan type', () => {
  it('STORE_PLANS contains exactly 4 known plans', () => {
    expect(STORE_PLANS).toEqual(['free', 'starter', 'professional', 'enterprise']);
  });

  it('compiles with type-correct plan references', () => {
    const p: StorePlan = 'starter';
    expect(getBaselineFeatures(p).length).toBeGreaterThan(0);
  });
});

describe('merchant-facing plan names (audit DOC-6): only Basic / Growth / Business', () => {
  const SOLD = ['Basic', 'Growth', 'Business'];
  it('names a sold plan for every feature that any tier unlocks', () => {
    for (const key of Object.keys(FEATURE_REGISTRY) as FeatureKey[]) {
      const label = publicPlanLabelForFeature(key);
      if (label) expect(SOLD).toContain(label.en);
    }
  });
  it('maps each tier to its sold plan; free is not sold', () => {
    expect(publicPlanForStorePlan('starter')?.en).toBe('Basic');
    expect(publicPlanForStorePlan('professional')?.en).toBe('Growth');
    expect(publicPlanForStorePlan('enterprise')?.en).toBe('Business');
    expect(publicPlanForStorePlan('free')).toBeNull();
  });
  it('loyalty is Growth, affiliate is Business, email campaigns stay Growth', () => {
    expect(publicPlanLabelForFeature('loyalty')?.code).toBe('growth');
    expect(publicPlanLabelForFeature('affiliate')?.code).toBe('business');
    expect(publicPlanLabelForFeature('email_campaigns')?.code).toBe('growth');
  });
});

describe('upgradeTargetForDisabledFeature', () => {
  it('offers Growth to a Basic store missing loyalty', () => {
    expect(upgradeTargetForDisabledFeature('basic', 'loyalty')?.code).toBe('growth');
  });
  it('offers Business to a Growth store missing affiliate', () => {
    expect(upgradeTargetForDisabledFeature('growth', 'affiliate')?.code).toBe('business');
  });
  it('is null when the plan already includes it (a toggle turned it off)', () => {
    expect(upgradeTargetForDisabledFeature('growth', 'loyalty')).toBeNull();
    expect(upgradeTargetForDisabledFeature('business', 'affiliate')).toBeNull();
  });
  it('is null for hidden or unknown plans and for features no sold plan unlocks', () => {
    expect(upgradeTargetForDisabledFeature('comped', 'loyalty')).toBeNull();
    expect(upgradeTargetForDisabledFeature('nope', 'loyalty')).toBeNull();
    expect(upgradeTargetForDisabledFeature('basic', 'nonexistent_feature' as never)).toBeNull();
  });
});

// Ruling BIZ-ALL-1 (Ahmad 2026-11-15): Business has every feature; nothing is sold separately.
describe('Business baseline = every registry feature', () => {
  const excluded = Object.keys(BUSINESS_BASELINE_EXCLUSIONS) as FeatureKey[];

  it('every registry key is in the enterprise baseline or in the documented exclusion map', () => {
    const missing = FEATURE_KEYS_ARRAY.filter(
      k => !PLAN_BASELINE.enterprise.includes(k) && !excluded.includes(k)
    );
    expect(missing).toEqual([]);
  });

  it('the exclusions are exactly the two keys that are not capabilities to switch on', () => {
    expect([...excluded].sort()).toEqual(['agent_checkout_open_writes', 'whatsapp']);
    for (const k of excluded) expect(PLAN_BASELINE.enterprise).not.toContain(k);
  });

  it('hidden-but-unfinished keys are entitled on Business', () => {
    for (const k of ['b2b.wholesale', 'eta_ereceipt', 'search_autocomplete', 'seo'] as FeatureKey[])
      expect(PLAN_BASELINE.enterprise).toContain(k);
  });

  it('Basic and Growth baselines did not gain the Business-only keys', () => {
    for (const k of [
      'bundles',
      'customer_intelligence',
      'eta_ereceipt',
      'inventory',
    ] as FeatureKey[]) {
      expect(PLAN_BASELINE.starter).not.toContain(k);
      expect(PLAN_BASELINE.professional).not.toContain(k);
    }
  });

  it('no registry feature carries the old "addon" (sold separately) tier', () => {
    for (const f of Object.values(FEATURE_REGISTRY)) expect(f.tier as string).not.toBe('addon');
  });
});
