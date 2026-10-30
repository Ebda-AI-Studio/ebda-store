import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  DEFAULT_PLAN_SEEDS,
  LOCKED_PUBLIC_PLANS,
  planIncludesMerchantMcp,
  planLimitsSchema,
} from '@ebda/shared';
import { PLANS, PRICING_PUBLISHED } from '../../apps/marketing/src/lib/plans';

const sql = readFileSync(
  'packages/database/prisma/migrations/20261007000000_locked_pricing/migration.sql',
  'utf8'
);

/** One `-- PLAN:<code>` block per plan in the migration. */
function migrationBlocks(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const chunk of sql.split('-- PLAN:').slice(1)) {
    out[chunk.slice(0, chunk.indexOf('\n'))] = chunk;
  }
  return out;
}

describe('locked pricing contract (docs/plans/2026-10-05-pricing-decisions.md)', () => {
  it('charges the agreed monthly and annual amounts without platform fees', () => {
    expect(LOCKED_PUBLIC_PLANS.map(p => [p.code, p.priceMonthlyMinor, p.priceYearlyMinor])).toEqual(
      [
        ['basic', 149000, 1341000],
        ['growth', 349000, 3141000],
        ['business', 999000, 8991000],
      ]
    );
    for (const p of LOCKED_PUBLIC_PLANS) {
      expect(planLimitsSchema.parse(p.limits).platformFeeBps).toBe(0);
      expect(p.limits.customDomain).toBe(true);
      expect(p.limits.maxProducts).toBeNull();
      // wa.me only, EXCEPT Business, which includes the Ebda WhatsApp package (Ruling WA-PKG-1,
      // Ahmad 2026-10-24; migration 20261104000200 and its pin below).
      expect(p.limits.whatsappAutomation).toBe(p.code === 'business');
    }
  });

  it('matches the entitlement table lever by lever', () => {
    const pick = (f: (l: (typeof LOCKED_PUBLIC_PLANS)[number]['limits']) => unknown) =>
      LOCKED_PUBLIC_PLANS.map(p => f(p.limits));
    expect(pick(l => l.maxStaff)).toEqual([2, 5, 15]);
    expect(pick(l => l.maxOrdersPerMonth)).toEqual([300, 3000, null]);
    expect(pick(l => l.maxStores)).toEqual([1, 1, 3]);
    expect(pick(l => l.abandonedCartAutomation)).toEqual([false, true, true]);
    expect(pick(l => l.brandingRemoval)).toEqual([false, true, true]);
    // apiAccess (future API/webhooks) stays Business-only; the MCP rule is `planIncludesMerchantMcp`.
    expect(pick(l => l.apiAccess)).toEqual([false, false, true]);
    expect(LOCKED_PUBLIC_PLANS.map(p => planIncludesMerchantMcp(p.code, p.limits))).toEqual([
      false,
      true,
      true,
    ]);
    expect(pick(l => l.analyticsTier)).toEqual(['basic', 'standard', 'advanced']);
    expect(pick(l => l.supportTier)).toEqual(['email', 'chat', 'priority']);
  });

  it('publishes the same amounts as the database catalog', () => {
    expect(PRICING_PUBLISHED).toBe(true);
    expect(PLANS.map(p => [p.id, p.price?.amountMinor, p.annualMinor])).toEqual(
      LOCKED_PUBLIC_PLANS.map(p => [p.code, p.priceMonthlyMinor, p.priceYearlyMinor])
    );
  });

  it('migration reproduces DEFAULT_PLAN_SEEDS exactly: one block per plan, same price, visibility, sort, tier, limits', () => {
    const blocks = migrationBlocks();
    expect(Object.keys(blocks)).toEqual(DEFAULT_PLAN_SEEDS.map(p => p.code));
    for (const p of DEFAULT_PLAN_SEEDS) {
      const b = blocks[p.code];
      const values = b.slice(b.indexOf('VALUES'), b.indexOf('ON CONFLICT'));
      const json = values.match(/'(\{.*\})'::jsonb/)![1];
      // `wholesalePricing` arrived later (20261028000200_b2b_product_columns_order_snapshots UPDATEs it onto the rows,
      // pinned in tests/unit/b2b-plan-gate.test.ts); this migration predates it, so compare every OTHER lever.
      // `whatsappAutomation` for Business was set later by 20261104000200 (WA-PKG-1); pinned below.
      const {
        wholesalePricing: _w,
        whatsappAutomation: _wa,
        catalogImportPagesPerMonth: _cs,
        ...seedLimits
      } = p.limits;
      const {
        wholesalePricing: _m,
        whatsappAutomation: _ma,
        catalogImportPagesPerMonth: _cm,
        ...migrated
      } = planLimitsSchema.parse(JSON.parse(json));
      expect(migrated, p.code).toEqual(seedLimits);
      const pm = p.priceMonthlyMinor === null ? 'NULL' : p.priceMonthlyMinor;
      const py = p.priceYearlyMinor === null ? 'NULL' : p.priceYearlyMinor;
      expect(values, p.code).toContain(
        `${p.sort}, ${p.isPublic}, '${p.featureTier}', ${pm}, ${py}, '`
      );
    }
  });

  it('migration never deletes or renames a plan code (existing subscriptions keep resolving)', () => {
    expect(sql).not.toMatch(/\bDELETE\b/i);
    expect(sql).not.toMatch(/\bDROP\b/i);
    expect(sql).not.toMatch(/\bUPDATE\s+store_subscriptions/i);
    for (const code of ['free', 'pro', 'comped', 'founding_free']) {
      expect(migrationBlocks()[code]).toBeDefined();
    }
  });
});

describe('Business includes the Ebda WhatsApp package (Ruling WA-PKG-1)', () => {
  it('a later migration flips only Business, idempotently', () => {
    const sql = readFileSync(
      join(
        __dirname,
        '../../packages/database/prisma/migrations/20261104000200_business_plan_includes_whatsapp/migration.sql'
      ),
      'utf8'
    );
    expect(sql).toMatch(/WHERE "code" = 'business'/);
    expect(sql).toMatch(/jsonb_set\("limits", '\{whatsappAutomation\}', 'true'::jsonb\)/);
    expect(sql).not.toMatch(/\bDELETE\b|\bDROP\b/i);
  });
});
