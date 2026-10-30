import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { DEFAULT_PLAN_SEEDS, planLimitsSchema } from '@ebda/shared';

const seed = (code: string) =>
  DEFAULT_PLAN_SEEDS.find(p => p.code === code)!.limits.catalogImportPagesPerMonth;

describe('catalogue import plan allowance (Ruling CATIMP-2)', () => {
  it('every seed carries the allowance; an old blob parses to OFF, never unlimited', () => {
    for (const p of DEFAULT_PLAN_SEEDS)
      expect(() => planLimitsSchema.parse(p.limits)).not.toThrow();
    const { catalogImportPagesPerMonth: _omit, ...rest } = DEFAULT_PLAN_SEEDS.find(
      p => p.code === 'growth'
    )!.limits;
    expect(planLimitsSchema.parse(rest).catalogImportPagesPerMonth).toBe(0);
    expect([seed('free'), seed('basic'), seed('growth'), seed('business')]).toEqual([
      0, 100, 400, 1500,
    ]);
  });

  it('the migration writes the same numbers as the seeds', () => {
    const sql = readFileSync(
      join(
        __dirname,
        '../../packages/database/prisma/migrations/20261108000200_catalog_import_plan_limits/migration.sql'
      ),
      'utf8'
    );
    expect(sql).toContain(`{"catalogImportPagesPerMonth":100}'::jsonb\n  WHERE "code" = 'basic'`);
    expect(sql).toContain(
      `{"catalogImportPagesPerMonth":1500}'::jsonb\n  WHERE "code" = 'business'`
    );
    expect(sql).toContain(
      `{"catalogImportPagesPerMonth":400}'::jsonb\n  WHERE "code" IN ('growth', 'pro')`
    );
    expect(sql).toContain(`NOT ("limits" ? 'catalogImportPagesPerMonth')`);
  });
});
