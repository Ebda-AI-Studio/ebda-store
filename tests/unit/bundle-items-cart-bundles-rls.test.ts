// tests/unit/bundle-items-cart-bundles-rls.test.ts — #1564
//
// 20260906120000_product_bundles's own comment claimed bundle_items and
// cart_bundles need "no RLS" because they're reachable only via an
// RLS-protected parent — directly contradicted by 20260609000000, which
// gives cart_items/order_items/return_items the OPPOSITE treatment: a
// parent-join `FOR ALL` policy. This pins the follow-up migration that gives
// bundle_items/cart_bundles the same shape.
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

const MIG_DIR = resolve(__dirname, '../../packages/database/prisma/migrations');

function migrationSql(nameFragment: string): string {
  const dir = readdirSync(MIG_DIR).find(d => d.includes(nameFragment));
  if (!dir) throw new Error(`migration matching "${nameFragment}" not found`);
  return readFileSync(resolve(MIG_DIR, dir, 'migration.sql'), 'utf8');
}

function stripComments(text: string): string {
  return text
    .split('\n')
    .filter(line => !line.trim().startsWith('--'))
    .join('\n');
}

describe('bundle_items / cart_bundles RLS follow-up (#1564)', () => {
  const sql = migrationSql('bundle_items_cart_bundles_rls');
  const ddl = stripComments(sql);

  it('does not edit the original, already-applied product_bundles migration', () => {
    // Editing an applied migration.sql changes its checksum, which `prisma
    // migrate deploy` treats as drift on the next deploy. The correction
    // belongs in a NEW migration, never a hand-edit of the old file.
    const original = migrationSql('product_bundles');
    expect(original).toMatch(/bundle_items and cart_bundles get no/);
  });

  it('enables and FORCES row level security on bundle_items', () => {
    expect(ddl).toMatch(/ALTER TABLE bundle_items ENABLE ROW LEVEL SECURITY/i);
    expect(ddl).toMatch(/ALTER TABLE bundle_items FORCE ROW LEVEL SECURITY/i);
  });

  it('enables and FORCES row level security on cart_bundles', () => {
    expect(ddl).toMatch(/ALTER TABLE cart_bundles ENABLE ROW LEVEL SECURITY/i);
    expect(ddl).toMatch(/ALTER TABLE cart_bundles FORCE ROW LEVEL SECURITY/i);
  });

  it('bundle_items policy is FOR ALL, resolving tenant via its real parent (bundles)', () => {
    const policy = ddl.match(
      /CREATE POLICY rls_bundle_items_tenant ON bundle_items[\s\S]*?;\s*ALTER TABLE bundle_items FORCE/i
    );
    expect(policy, 'bundle_items policy not found').not.toBeNull();
    const block = policy![0];
    expect(block).toMatch(/FOR ALL TO \w+_app/i);
    expect(block).toMatch(/FROM bundles b/i);
    expect(block).toMatch(/b\.id = bundle_items\.bundle_id/i);
    expect(block).toMatch(/b\.store_id = current_store_id\(\)/i);
    expect(block).toMatch(/WITH CHECK/i);
  });

  it('cart_bundles policy is FOR ALL, resolving tenant via its real parent (carts)', () => {
    const policy = ddl.match(
      /CREATE POLICY rls_cart_bundles_tenant ON cart_bundles[\s\S]*?;\s*ALTER TABLE cart_bundles FORCE/i
    );
    expect(policy, 'cart_bundles policy not found').not.toBeNull();
    const block = policy![0];
    expect(block).toMatch(/FOR ALL TO \w+_app/i);
    expect(block).toMatch(/FROM carts c/i);
    expect(block).toMatch(/c\.id = cart_bundles\.cart_id/i);
    expect(block).toMatch(/c\.store_id/i);
    expect(block).toMatch(/WITH CHECK/i);
  });

  it('every policy carries the app.bypass_rls escape hatch (super-admin / crons)', () => {
    const bypassCount = (ddl.match(/app\.bypass_rls/g) ?? []).length;
    // 2 policies × (USING + WITH CHECK) × 1 bypass mention each = 4, but each
    // clause references it inside its EXISTS too — assert a floor, not an
    // exact count, so a harmless rewrap doesn't break this test.
    expect(bypassCount).toBeGreaterThanOrEqual(4);
  });

  it('drops nothing and writes no data', () => {
    expect(sql).not.toMatch(/DROP\s+(TABLE|COLUMN)/i);
    expect(sql).not.toMatch(/^\s*(INSERT|UPDATE|DELETE)\s+/im);
  });
});
