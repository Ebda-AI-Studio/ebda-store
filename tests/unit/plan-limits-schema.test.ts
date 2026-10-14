/**
 * SP5 task 1 — the plan-limits zod schema, the seed plans, and the migration's
 * seed + backfill staying in lockstep with @ebda/shared.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import {
  DEFAULT_PLAN_SEEDS,
  GATED_LIMIT_KEYS,
  LEGACY_STORE_PLAN_TO_PLAN_CODE,
  STORE_PLAN_TO_PLAN_CODE,
  STORE_PLANS,
  PLAN_BASELINE,
  planLimitsSchema,
  planLimitMessage,
  updatePlanSchema,
} from '@ebda/shared';

const sql = fs.readFileSync(
  path.resolve(
    __dirname,
    '../../packages/database/prisma/migrations/20261003130000_plans_and_store_subscriptions/migration.sql'
  ),
  'utf8'
);

const valid = DEFAULT_PLAN_SEEDS[0].limits;

describe('planLimitsSchema', () => {
  it('accepts every seed plan', () => {
    for (const p of DEFAULT_PLAN_SEEDS)
      expect(planLimitsSchema.safeParse(p.limits).success).toBe(true);
  });

  it('null on a numeric limit means unlimited, and is accepted', () => {
    const r = planLimitsSchema.parse({ ...valid, maxProducts: null, maxStaff: null });
    expect(r.maxProducts).toBeNull();
  });

  it('a missing numeric key is rejected (undefined is NOT unlimited)', () => {
    const { maxProducts: _omit, ...rest } = valid;
    expect(planLimitsSchema.safeParse(rest).success).toBe(false);
  });

  it('the locked-pricing keys are required and tiers are enums (a typo cannot lift a gate)', () => {
    for (const k of ['maxStores', 'brandingRemoval', 'apiAccess', 'analyticsTier', 'supportTier']) {
      const { [k]: _omit, ...rest } = valid as Record<string, unknown>;
      expect(planLimitsSchema.safeParse(rest).success, k).toBe(false);
    }
    expect(planLimitsSchema.safeParse({ ...valid, analyticsTier: 'pro' }).success).toBe(false);
    expect(planLimitsSchema.safeParse({ ...valid, supportTier: 'vip' }).success).toBe(false);
  });

  it('rejects negatives, fractions, out-of-range bps and unknown keys', () => {
    expect(planLimitsSchema.safeParse({ ...valid, maxStaff: -1 }).success).toBe(false);
    expect(planLimitsSchema.safeParse({ ...valid, maxProducts: 1.5 }).success).toBe(false);
    expect(planLimitsSchema.safeParse({ ...valid, platformFeeBps: 10_001 }).success).toBe(false);
    expect(planLimitsSchema.safeParse({ ...valid, bogus: 1 }).success).toBe(false);
    expect(planLimitsSchema.safeParse({ ...valid, customDomain: 'yes' }).success).toBe(false);
  });

  it('codPlatformFeeBps defaults to 0 when absent', () => {
    const { codPlatformFeeBps: _omit, ...rest } = valid;
    expect(planLimitsSchema.parse(rest).codPlatformFeeBps).toBe(0);
  });

  it('updatePlanSchema keeps prices nullable ("not set yet") and rejects negative prices', () => {
    const base = {
      nameEn: 'X',
      nameAr: 'س',
      sort: 1,
      isPublic: true,
      priceMonthlyMinor: null,
      priceYearlyMinor: null,
      limits: valid,
    };
    expect(updatePlanSchema.safeParse(base).success).toBe(true);
    expect(updatePlanSchema.safeParse({ ...base, priceMonthlyMinor: 149900 }).success).toBe(true);
    expect(updatePlanSchema.safeParse({ ...base, priceMonthlyMinor: -1 }).success).toBe(false);
  });
});

describe('seed plans', () => {
  it('are the locked catalog plus hidden compatibility rows; only comped/founding_free are unlimited', () => {
    expect(DEFAULT_PLAN_SEEDS.map(p => p.code)).toEqual([
      'free',
      'basic',
      'growth',
      'business',
      'pro',
      'comped',
      'founding_free',
    ]);
    expect(DEFAULT_PLAN_SEEDS.filter(p => p.isPublic).map(p => p.code)).toEqual([
      'basic',
      'growth',
      'business',
    ]);
    for (const code of ['comped', 'founding_free']) {
      const row = DEFAULT_PLAN_SEEDS.find(p => p.code === code)!;
      expect(row.isPublic).toBe(false);
      for (const k of ['maxProducts', 'maxStaff', 'maxOrdersPerMonth', 'maxStorageMb'] as const)
        expect(row.limits[k]).toBeNull();
      expect(row.limits.maxStores).toBeNull();
    }
  });

  it('zero platform fee and zero COD fee on every plan (locked: no commission)', () => {
    for (const p of DEFAULT_PLAN_SEEDS) {
      expect(p.limits.platformFeeBps).toBe(0);
      expect(p.limits.codPlatformFeeBps).toBe(0);
    }
  });

  it('hidden plans carry no price; public plans: yearly = 9 x monthly (25% off)', () => {
    for (const p of DEFAULT_PLAN_SEEDS) {
      if (!p.isPublic) expect([p.priceMonthlyMinor, p.priceYearlyMinor]).toEqual([null, null]);
      else expect(p.priceYearlyMinor).toBe(p.priceMonthlyMinor! * 9);
    }
  });

  it('every featureTier is a real StorePlan with a PLAN_BASELINE', () => {
    for (const p of DEFAULT_PLAN_SEEDS) {
      expect(STORE_PLANS).toContain(p.featureTier);
      expect(PLAN_BASELINE[p.featureTier]).toBeDefined();
    }
  });

  it('runtime enum -> plan map points the three paying tiers at the three public plans', () => {
    expect(STORE_PLAN_TO_PLAN_CODE).toEqual({
      free: 'free',
      starter: 'basic',
      professional: 'growth',
      enterprise: 'business',
    });
    for (const [tier, code] of Object.entries(STORE_PLAN_TO_PLAN_CODE)) {
      expect(DEFAULT_PLAN_SEEDS.find(p => p.code === code)!.featureTier).toBe(tier);
    }
  });
});

describe('original SP5 migration (frozen history)', () => {
  it('seeded the four historical codes with the nine original limit keys and no prices', () => {
    const seed = sql.slice(sql.indexOf('-- SEED:BEGIN'), sql.indexOf('-- SEED:END'));
    expect(seed).not.toMatch(/price_/);
    const rows = [...seed.matchAll(/\('?[^\n]*?'(\{.*?\})'::jsonb\)/g)];
    expect(rows).toHaveLength(4);
    for (const m of rows) expect(Object.keys(JSON.parse(m[1]))).toHaveLength(9);
    for (const code of ['free', 'growth', 'pro', 'comped']) expect(seed).toContain(`'${code}'`);
  });

  it('backfill CASE mirrors LEGACY_STORE_PLAN_TO_PLAN_CODE', () => {
    const backfill = sql.slice(sql.indexOf('-- BACKFILL:BEGIN'), sql.indexOf('-- BACKFILL:END'));
    for (const [legacy, code] of Object.entries(LEGACY_STORE_PLAN_TO_PLAN_CODE)) {
      expect(backfill).toContain(`WHEN '${legacy}' THEN '${code}'`);
    }
  });
});

describe('PLAN_LIMIT_REACHED copy', () => {
  it('has English and Arabic text for every gated limit key', () => {
    for (const k of GATED_LIMIT_KEYS) {
      expect(planLimitMessage(k, 5, 'en')).toMatch(/[A-Za-z]/);
      expect(planLimitMessage(k, 5, 'ar')).toMatch(/[؀-ۿ]/);
    }
    expect(planLimitMessage('maxProducts', 50, 'en')).toContain('50');
  });
});
