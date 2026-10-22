/**
 * Gold-rate pricing, Task 9: the migration's security-critical statements are pinned as text, so the
 * defence-mutation record (docs/security/defence-mutations.json) can delete each one and prove this
 * file goes red. The DB-behaviour proofs are the integration tests (gold-rate-rls, gold-price-guard-trigger);
 * this is the tier that runs without a database.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const sql = readFileSync(
  path.resolve(
    __dirname,
    '../../packages/database/prisma/migrations/20261102000200_gold_rate_pricing/migration.sql'
  ),
  'utf8'
);
const code = sql
  .split('\n')
  .filter(l => !l.trim().startsWith('--'))
  .join('\n');

describe('20261102000200_gold_rate_pricing: security statements', () => {
  for (const table of ['gold_rates', 'gold_rates_current', 'gold_rate_settings']) {
    it(`${table}: ENABLE + FORCE row level security and ONE strict ebda_app policy`, () => {
      expect(code).toContain(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY;`);
      expect(code).toContain(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY;`);
      const policy = new RegExp(
        `CREATE POLICY ebda_tenant_isolation ON ${table} AS PERMISSIVE FOR ALL TO ebda_app\\s+USING \\(store_id = nullif\\(current_setting\\('app\\.current_store_id', true\\), ''\\)\\)\\s+WITH CHECK \\(store_id = nullif\\(current_setting\\('app\\.current_store_id', true\\), ''\\)\\);`
      );
      expect(code).toMatch(policy);
      // no allowance for a missing tenant, no bypass flag
      expect(code).not.toMatch(/IS NULL\)\s*;?\s*WITH CHECK/);
      expect(code).not.toMatch(/app\.bypass_rls/);
    });
  }
  it('gold_rates is append-only for ebda_app: all privileges revoked, then SELECT/INSERT and a column UPDATE only', () => {
    expect(code).toContain('REVOKE ALL ON gold_rates FROM ebda_app;');
    expect(code).toContain('GRANT SELECT, INSERT ON gold_rates TO ebda_app;');
    expect(code).toContain(
      'GRANT UPDATE (status, decided_by, applied_at) ON gold_rates TO ebda_app;'
    );
    expect(code).not.toMatch(/GRANT[^;]*DELETE[^;]*ON gold_rates TO/);
    expect(code).not.toMatch(/GRANT UPDATE ON gold_rates /);
  });
  it('the price guard trigger exists on both tables and fires on price, compare_at_price and the mode', () => {
    for (const table of ['products', 'product_variants'])
      expect(code).toContain(
        `CREATE TRIGGER ebda_gold_price_guard BEFORE INSERT OR UPDATE OF price, compare_at_price, pricing_mode ON ${table}`
      );
  });
  it('the guard reads a TRANSACTION-LOCAL setting and refuses with GOLD_PRICE_MANAGED / P0001', () => {
    // once in the products function and once in the variants function
    expect(
      code.split("coalesce(current_setting('app.gold_reprice', true), '') <> 'on'")
    ).toHaveLength(3);
    expect(code).toContain("USING ERRCODE = 'P0001'");
    expect(code).toContain('GOLD_PRICE_MANAGED');
  });
  it('a gold row cannot carry a compare-at price (Ruling B5-19) and a gold spec must be complete', () => {
    expect(code).toContain(
      `"products_gold_no_compare_check" CHECK ("pricing_mode" = 'fixed' OR "compare_at_price" IS NULL)`
    );
    expect(code).toContain('"products_gold_spec_complete_check"');
  });
  it('the rate bounds and the 26 hour ceiling are CHECK constraints', () => {
    expect(code).toContain('CHECK ("rate_per_gram" BETWEEN 10000 AND 10000000)');
    expect(code).toContain('CHECK ("max_age_minutes" BETWEEN 60 AND 1560)');
  });
});
