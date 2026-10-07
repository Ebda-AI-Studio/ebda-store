import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { LOCKED_PUBLIC_PLANS, planLimitsSchema } from '@force/shared';
import { PLANS, PRICING_PUBLISHED } from '../../apps/marketing/src/lib/plans';

describe('locked pricing contract', () => {
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
    }
    expect(LOCKED_PUBLIC_PLANS.map(p => [p.limits.maxStaff, p.limits.maxOrdersPerMonth])).toEqual([
      [2, 300],
      [5, 3000],
      [15, null],
    ]);
  });
  it('publishes the same amounts as the database catalog', () => {
    expect(PRICING_PUBLISHED).toBe(true);
    expect(PLANS.map(p => [p.id, p.price?.amountMinor, p.annualMinor])).toEqual(
      LOCKED_PUBLIC_PLANS.map(p => [p.code, p.priceMonthlyMinor, p.priceYearlyMinor])
    );
    const sql = readFileSync(
      'packages/database/prisma/migrations/20261005090000_locked_pricing/migration.sql',
      'utf8'
    );
    for (const p of LOCKED_PUBLIC_PLANS) {
      const row = sql
        .split('\n')
        .find(line => line.startsWith('INSERT') && line.includes(`'${p.code}'`));
      expect(row).toContain(`${p.priceMonthlyMinor}, ${p.priceYearlyMinor}`);
      expect(row).toContain(JSON.stringify(p.limits).replaceAll(':', ': ').replaceAll(',', ', '));
    }
  });
});
