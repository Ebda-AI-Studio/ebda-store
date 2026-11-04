#!/usr/bin/env node
// READ-ONLY ops check (QA-PRICE-ZERO-1 / QA-COUPON-1): lists, across ALL stores,
//   1. ACTIVE products priced 0 (not gold-rate, not draft/archived, not soft-deleted; a product with variant rows is
//      judged on its variants),
//   2. ACTIVE variants whose effective price (own price, else the product's) is 0, on an active, non-gold product,
//   3. coupons with value <= 0 on a percentage/fixed type (a free_shipping coupon carries no value and is fine).
// Nothing is written: one connection, `BEGIN READ ONLY`, SELECTs only, ROLLBACK at the end.
//
// Usage:  DATABASE_URL=<owner-role url, bypasses RLS> node scripts/ops/check-free-items-and-valueless-coupons.mjs [--json] [--fail]
//   --json  machine-readable output     --fail  exit 1 when anything is found (default exit 0; 2 = could not run)
// The tenant tables are under strict RLS: a connection as `ebda_app` sees nothing. Use the owner role (the same one the
// other scripts/ use, e.g. neonctl connection-string ... | for a read-only look at production). Never pass a write URL
// you would not want READ ONLY enforced on; the transaction mode is what makes this safe, not the caller.
import pg from 'pg';

const JSON_OUT = process.argv.includes('--json');
const FAIL = process.argv.includes('--fail');
const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is required (owner role: tenant tables are under strict RLS).');
  process.exit(2);
}

export const QUERIES = {
  freeActiveProducts: `
    SELECT p.store_id, p.id, p.name, p.slug, p.price, p.status
      FROM products p
     WHERE p.status = 'active' AND p.deleted_at IS NULL AND p.pricing_mode <> 'gold_rate' AND p.price <= 0
       AND NOT EXISTS (SELECT 1 FROM product_variants v WHERE v.product_id = p.id)
     ORDER BY p.store_id, p.name`,
  freeActiveVariants: `
    SELECT p.store_id, p.id AS product_id, v.id AS variant_id, p.name, v.title, v.price AS variant_price, p.price AS product_price
      FROM product_variants v
      JOIN products p ON p.id = v.product_id
     WHERE p.status = 'active' AND p.deleted_at IS NULL AND p.pricing_mode <> 'gold_rate'
       AND v.is_active AND COALESCE(v.pricing_mode, 'fixed') <> 'gold_rate'
       AND COALESCE(v.price, p.price) <= 0
     ORDER BY p.store_id, p.name, v.title`,
  valuelessCoupons: `
    SELECT c.store_id, c.id, c.code, c.type, c.value, c.is_active
      FROM coupons c
     WHERE c.type <> 'free_shipping' AND c.value <= 0
     ORDER BY c.store_id, c.code`,
};

const client = new pg.Client({ connectionString: url });
await client.connect();
const report = {};
try {
  await client.query('BEGIN READ ONLY');
  for (const [name, sql] of Object.entries(QUERIES)) report[name] = (await client.query(sql)).rows;
} finally {
  await client.query('ROLLBACK').catch(() => undefined);
  await client.end();
}

const total = Object.values(report).reduce((n, rows) => n + rows.length, 0);
if (JSON_OUT) {
  console.log(JSON.stringify({ total, ...report }, null, 2));
} else {
  for (const [name, rows] of Object.entries(report)) {
    console.log(`\n== ${name}: ${rows.length}`);
    for (const r of rows) console.log(' ', JSON.stringify(r));
  }
  console.log(`\n${total} finding(s). READ ONLY: nothing was written.`);
}
process.exit(FAIL && total > 0 ? 1 : 0);
