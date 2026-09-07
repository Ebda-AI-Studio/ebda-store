// tests/unit/bundle-schema.test.ts
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

const MIG_DIR = resolve(__dirname, '../../packages/database/prisma/migrations');

function bundleMigrationSql(): string {
  const dir = readdirSync(MIG_DIR).find(d => d.includes('product_bundles'));
  if (!dir) throw new Error('product_bundles migration not found');
  return readFileSync(resolve(MIG_DIR, dir, 'migration.sql'), 'utf8');
}

// Strips SQL line comments before any assertion is asked to distinguish
// "the migration says X in prose" from "the migration DOES X in DDL". Both
// the cart_items and the bundle_items.product_id assertions below matched
// this file's own explanatory header comments in earlier rounds (comments
// that literally describe the constraint they sit next to), which let a
// mutated/regressed DDL statement pass invisibly behind unchanged prose. A
// guard that can pass on comments alone is not a guard.
function stripComments(text: string): string {
  return text
    .split('\n')
    .filter(line => !line.trim().startsWith('--'))
    .join('\n');
}

describe('product bundles migration is additive', () => {
  const sql = bundleMigrationSql();

  it('drops nothing', () => {
    expect(sql).not.toMatch(/DROP\s+(TABLE|COLUMN|INDEX|CONSTRAINT)/i);
  });

  it('never makes an existing column NOT NULL', () => {
    expect(sql).not.toMatch(/ALTER\s+COLUMN[\s\S]*?SET\s+NOT\s+NULL/i);
  });

  it('does not touch cart_items or its partial unique indexes', () => {
    // Expanding a bundle into cart_items would violate
    // (cart_id, product_id) WHERE variant_id IS NULL the moment a bundle
    // contains a product already in the cart. CartBundle exists to avoid it.
    //
    // Asserted on ANY statement, not just ALTER TABLE: a bare
    // `DROP INDEX "cart_items_..."` is equally fatal and slipped past the
    // narrower check this assertion used to make. Comment LINES are
    // stripped before splitting into statements (not just whole-statement
    // chunks starting with "--") so the header's own prose explaining why
    // cart_items is untouched doesn't trip this into a false positive —
    // only an actual SQL statement naming cart_items should fail this.
    const statements = stripComments(sql)
      .split(';')
      .map(s => s.trim())
      .filter(Boolean);
    const touching = statements.filter(s => /cart_items/i.test(s));
    expect(touching, `migration touches cart_items:\n${touching.join('\n')}`).toEqual([]);
    expect(sql).toMatch(/CREATE\s+TABLE\s+"?cart_bundles"?/i);
  });

  it('restricts product deletion rather than cascading a live bundle away', () => {
    // Assert on comment-stripped DDL, on the actual FK statement, not on
    // "ON DELETE RESTRICT" appearing anywhere in the file. The migration's
    // own header comment says "bundle_items.product_id is ON DELETE
    // RESTRICT (not CASCADE)" in prose — flipping the real FK to CASCADE
    // while leaving that comment untouched previously left this assertion
    // green, because [\s\S]*? happily spanned from "bundle_items" in the
    // comment straight through to "ON DELETE RESTRICT" also in the comment,
    // never once looking at the DDL below it.
    const ddl = stripComments(sql);
    const fk = ddl.match(
      /ALTER TABLE[^;]*"bundle_items"[^;]*FOREIGN KEY\s*\("product_id"\)[^;]*;/i
    );
    expect(fk, 'no bundle_items.product_id FK found in DDL').not.toBeNull();
    expect(fk![0]).toMatch(/ON DELETE RESTRICT/i);
    expect(fk![0]).not.toMatch(/ON DELETE CASCADE/i);
  });

  it('adds order columns as nullable / defaulted only', () => {
    expect(sql).toMatch(/ALTER TABLE "?order_items"?[\s\S]*?ADD COLUMN "?bundle_group_id"?/i);
    expect(sql).toMatch(
      /ALTER TABLE "?orders"?[\s\S]*?ADD COLUMN "?bundle_discount"?[^;]*DEFAULT 0/i
    );
  });

  it('constrains bundle_items.quantity to a sane range (1-1000)', () => {
    // A negative/zero quantity made allocateBundlePrice loop forever (a
    // hang). A valid but extreme quantity (e.g. paired with another line's
    // tiny quantity) made it run tens to hundreds of millions of iterations
    // instead (RULING T2-c) -- the algorithm is now fixed to not step
    // per-unit, but the DB still bounds quantity to what a real kit could
    // ever hold (1-1000; real kits hold 1-20 of a thing) as defence in
    // depth, behind Zod and the function's own guard.
    const ddl = stripComments(sql);
    expect(ddl).toMatch(
      /CHECK\s*\(\s*"?quantity"?\s*>=\s*1\s*AND\s*"?quantity"?\s*<=\s*1000\s*\)/i
    );
  });

  it('enables forced RLS on the tenant-scoped bundles table', () => {
    expect(sql).toMatch(/ALTER TABLE "bundles" ENABLE ROW LEVEL SECURITY/i);
    expect(sql).toMatch(/ALTER TABLE "bundles" FORCE ROW LEVEL SECURITY/i);
    for (const op of ['SELECT', 'INSERT', 'UPDATE', 'DELETE']) {
      expect(sql, `missing bundles RLS policy for ${op}`).toMatch(
        new RegExp(`CREATE POLICY "bundles_app_\\w+" ON "bundles" FOR ${op}`, 'i')
      );
    }
  });
});
