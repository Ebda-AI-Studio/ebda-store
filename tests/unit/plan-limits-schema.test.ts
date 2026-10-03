/**
 * SP5 task 1 — the plan-limits zod schema, the seed plans, and the migration's
 * seed + backfill staying in lockstep with @force/shared.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import {
  DEFAULT_PLAN_SEEDS,
  GATED_LIMIT_KEYS,
  LEGACY_STORE_PLAN_TO_PLAN_CODE,
  STORE_PLANS,
  PLAN_BASELINE,
  planLimitsSchema,
  planLimitMessage,
  updatePlanSchema,
} from '@force/shared';

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
  it('are free, growth, pro, comped; only comped is non-public and fully unlimited', () => {
    expect(DEFAULT_PLAN_SEEDS.map(p => p.code)).toEqual(['free', 'growth', 'pro', 'comped']);
    const comped = DEFAULT_PLAN_SEEDS.find(p => p.code === 'comped')!;
    expect(comped.isPublic).toBe(false);
    for (const k of ['maxProducts', 'maxStaff', 'maxOrdersPerMonth', 'maxStorageMb'] as const)
      expect(comped.limits[k]).toBeNull();
    expect(comped.limits.platformFeeBps).toBe(0);
    expect(DEFAULT_PLAN_SEEDS.filter(p => !p.isPublic)).toHaveLength(1);
  });

  it('COD platform fee is 0 on every seed plan', () => {
    for (const p of DEFAULT_PLAN_SEEDS) expect(p.limits.codPlatformFeeBps).toBe(0);
  });

  it('every featureTier is a real StorePlan with a PLAN_BASELINE', () => {
    for (const p of DEFAULT_PLAN_SEEDS) {
      expect(STORE_PLANS).toContain(p.featureTier);
      expect(PLAN_BASELINE[p.featureTier]).toBeDefined();
    }
  });
});

describe('migration SQL parity', () => {
  it('seeds exactly the DEFAULT_PLAN_SEEDS rows (no prices, same limits JSON)', () => {
    const seed = sql.slice(sql.indexOf('-- SEED:BEGIN'), sql.indexOf('-- SEED:END'));
    expect(seed).not.toMatch(/price_/);
    const rows = [...seed.matchAll(/\('?[^\n]*?'(\{.*?\})'::jsonb\)/g)];
    expect(rows).toHaveLength(DEFAULT_PLAN_SEEDS.length);
    rows.forEach((m, i) => {
      const fromSql = planLimitsSchema.parse(JSON.parse(m[1]));
      expect(fromSql).toEqual(DEFAULT_PLAN_SEEDS[i].limits);
      expect(seed.split('\n').find(l => l.includes(m[1]))).toContain(
        `'${DEFAULT_PLAN_SEEDS[i].code}'`
      );
      expect(seed.split('\n').find(l => l.includes(m[1]))).toContain(
        `'${DEFAULT_PLAN_SEEDS[i].featureTier}'`
      );
    });
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
