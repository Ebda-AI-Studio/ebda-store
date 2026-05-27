import { describe, it, expect } from 'vitest';
import {
  PLAN_BASELINE,
  STORE_PLANS,
  PLAN_LABELS,
  getBaselineFeatures,
  isInBaseline,
  type StorePlan,
} from '../plan-baselines';
import { FEATURE_REGISTRY, type FeatureKey } from '../features';

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

  it('professional does NOT include multi-warehouse or profit anomaly (enterprise-only)', () => {
    expect(PLAN_BASELINE.professional).not.toContain('inventory.multi_warehouse');
    expect(PLAN_BASELINE.professional).not.toContain('accounting.profit_anomaly');
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

  it('legacy `inventory` parent flag is NOT in any baseline (replaced by inventory.*)', () => {
    for (const plan of STORE_PLANS) {
      expect(PLAN_BASELINE[plan]).not.toContain('inventory');
    }
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
