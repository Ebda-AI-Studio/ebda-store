/**
 * Plan gate for B2B wholesale pricing (docs/plans/done/2026-10-21-b2b-wholesale.md, Task 1; Ruling B2B-1, Ahmad 2026-10-21:
 * Business plan only, comped = everything on). Feature key `b2b.wholesale`, plan limit `wholesalePricing`.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  DEFAULT_PLAN_SEEDS,
  FEATURE_KEYS_ARRAY,
  FEATURE_REGISTRY,
  PLAN_BASELINE,
  STORE_PLANS,
  BOOLEAN_LIMIT_KEYS,
  planLimitsSchema,
  planLimitMessage,
} from '@ebda/shared';

const m = vi.hoisted(() => ({
  storeFindUnique: vi.fn(),
  featureRows: vi.fn(),
  sub: vi.fn(),
  planFind: vi.fn(),
}));
vi.mock('@api/services/billing/addon-grant', () => ({ activeAddons: async () => [] }));
vi.mock('@api/services/redis.service', () => ({
  redis: { get: vi.fn().mockResolvedValue(null), set: vi.fn(), delete: vi.fn() },
}));
vi.mock('@ebda/database', () => ({
  prisma: {},
  Prisma: {},
  withMoneyTx: vi.fn(),
  withUser: async (_id: string, fn: (tx: unknown) => unknown) => fn({}),
  withStore: async (_id: string, fn: (tx: unknown) => unknown) =>
    fn({
      store: { findUnique: m.storeFindUnique },
      storeFeature: { findMany: m.featureRows },
      storeSubscription: { findUnique: m.sub },
      plan: { findUnique: m.planFind },
    }),
}));
vi.mock('@api/services/socket.service', () => ({ socketService: {} }));
vi.mock('@api/services/email.service', () => ({ EmailService: {} }));
vi.mock('@api/services/store.service', () => ({ bustStoreCaches: vi.fn() }));
vi.mock('@api/config', () => ({ config: {} }));
vi.mock('@api/lib/logger', () => ({
  default: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import { featureService } from '@api/services/feature.service';

const seed = (code: string) => DEFAULT_PLAN_SEEDS.find(p => p.code === code)!;

function onPlan(code: string, status = 'active') {
  m.storeFindUnique.mockResolvedValue({ plan: 'enterprise' });
  m.featureRows.mockResolvedValue([]);
  m.sub.mockResolvedValue({ planCode: code, status });
  m.planFind.mockImplementation(async ({ where }: { where: { code: string } }) => {
    const s = seed(where.code);
    return s ? { ...s, nameEn: s.nameEn, nameAr: s.nameAr, limits: s.limits } : null;
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('plan limit `wholesalePricing`', () => {
  it('is ON for business and comped only (Ruling B2B-1)', () => {
    const on = DEFAULT_PLAN_SEEDS.filter(p => p.limits.wholesalePricing).map(p => p.code);
    expect(on.sort()).toEqual(['business', 'comped']);
  });

  it('a stored limits blob WITHOUT the key still parses, to OFF (the corrupt-blob fallback must not flip a gate open)', () => {
    const { wholesalePricing: _omit, ...legacy } = seed('business').limits;
    const parsed = planLimitsSchema.parse(legacy);
    expect(parsed.wholesalePricing).toBe(false);
  });

  it('rejects a non-boolean value (a typo cannot lift the gate)', () => {
    expect(
      planLimitsSchema.safeParse({ ...seed('business').limits, wholesalePricing: 'yes' }).success
    ).toBe(false);
  });

  it('is a gated boolean key with English and Arabic upgrade copy', () => {
    expect(BOOLEAN_LIMIT_KEYS).toContain('wholesalePricing');
    expect(planLimitMessage('wholesalePricing', false, 'en')).toMatch(/[A-Za-z]/);
    expect(planLimitMessage('wholesalePricing', false, 'ar')).toMatch(/[؀-ۿ]/);
  });
});

describe('feature key `b2b.wholesale`', () => {
  it('is registered with bilingual copy and is in the Business baseline only (BIZ-ALL-1; the plan limit still decides, like remove_branding)', () => {
    expect(FEATURE_KEYS_ARRAY).toContain('b2b.wholesale');
    const def = FEATURE_REGISTRY['b2b.wholesale'];
    expect(def.name.length).toBeGreaterThan(0);
    expect(def.nameAr).toMatch(/[؀-ۿ]/);
    for (const plan of STORE_PLANS)
      expect(PLAN_BASELINE[plan].includes('b2b.wholesale')).toBe(plan === 'enterprise');
  });

  it.each([
    ['basic', false],
    ['growth', false],
    ['pro', false],
    ['free', false],
    ['founding_free', false],
    ['business', true],
    ['comped', true],
  ])(
    '%s => b2b.wholesale = %s (server-resolved through FeatureService)',
    async (code, expected) => {
      onPlan(code);
      expect((await featureService.getStoreFeatures(`st-${code}`))['b2b.wholesale']).toBe(expected);
    }
  );

  it('a canceled Business subscription falls back to free => off', async () => {
    onPlan('business', 'canceled');
    expect((await featureService.getStoreFeatures('st-canceled'))['b2b.wholesale']).toBe(false);
  });

  it('a super-admin StoreFeature override wins both ways', async () => {
    onPlan('business');
    m.featureRows.mockResolvedValue([{ featureKey: 'b2b.wholesale', enabled: false }]);
    expect((await featureService.getStoreFeatures('st-off'))['b2b.wholesale']).toBe(false);
    onPlan('growth');
    m.featureRows.mockResolvedValue([{ featureKey: 'b2b.wholesale', enabled: true }]);
    expect((await featureService.getStoreFeatures('st-on'))['b2b.wholesale']).toBe(true);
  });
});

describe('migration 20261028000200 writes the plan entitlement onto the live plans rows', () => {
  const sql = readFileSync(
    'packages/database/prisma/migrations/20261028000200_b2b_product_columns_order_snapshots/migration.sql',
    'utf8'
  );
  it('sets wholesalePricing true for exactly business + comped and false for every other plan', () => {
    expect(sql).toContain(
      `"limits" || '{"wholesalePricing":true}'::jsonb WHERE "code" IN ('business', 'comped')`
    );
    expect(sql).toContain(
      `"limits" || '{"wholesalePricing":false}'::jsonb WHERE "code" NOT IN ('business', 'comped')`
    );
  });
  it('matches the seeds', () => {
    for (const p of DEFAULT_PLAN_SEEDS) {
      expect(p.limits.wholesalePricing, p.code).toBe(p.code === 'business' || p.code === 'comped');
    }
  });
});
