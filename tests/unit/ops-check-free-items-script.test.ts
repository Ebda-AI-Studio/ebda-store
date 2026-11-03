/** The ops check is READ-ONLY by construction: pinned on the source (it is run against production by the controller). */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const src = readFileSync(
  join(__dirname, '../../scripts/ops/check-free-items-and-valueless-coupons.mjs'),
  'utf8'
);
describe('check-free-items-and-valueless-coupons.mjs', () => {
  it('runs inside BEGIN READ ONLY, rolls back, and contains only SELECT statements', () => {
    expect(src).toContain("'BEGIN READ ONLY'");
    expect(src).toContain("'ROLLBACK'");
    expect(src).not.toMatch(/\b(INSERT|UPDATE|DELETE|DROP|ALTER|TRUNCATE|CREATE)\b\s/i);
  });
  it('excludes gold-rate, draft/archived and variant-product parents from the product finding', () => {
    expect(src).toContain("p.pricing_mode <> 'gold_rate'");
    expect(src).toContain("p.status = 'active'");
    expect(src).toContain('NOT EXISTS (SELECT 1 FROM product_variants');
  });
  it('flags coupons with value <= 0 except free_shipping', () => {
    expect(src).toContain("c.type <> 'free_shipping' AND c.value <= 0");
  });
});
