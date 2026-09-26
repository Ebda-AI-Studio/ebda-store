/**
 * Forward-looking migration lock-safety gate (#963, #1012, #1808).
 *
 * The triage on all three confirmed the same shape across six migration
 * files: a backfill `UPDATE` paired with `ALTER COLUMN ... SET NOT NULL` in
 * one migration, or an unbounded `UPDATE` on a hot/large table (orders,
 * products, carts, cart_items) — either can hold a table lock for the
 * duration of the backfill while Postgres runs the migration at boot.
 *
 * All six are HISTORICAL: Prisma applies a migration exactly once per
 * environment, they are dated 2026-04 through 2026-09 and are already live in
 * production, and rewriting an applied `migration.sql` breaks the checksum
 * `_prisma_migrations` tracks — so they are grandfathered here, not edited.
 * (#1012's `20260808120000_fk_only_indexes` self-documents its own
 * CONCURRENTLY fallback and is grandfathered for the same reason, even though
 * it does not match either pattern below.)
 *
 * What IS actionable: nothing enforced the pattern from recurring. This test
 * is that enforcement — it fails the moment a NEW migration (any directory
 * name not in `GRANDFATHERED`) reintroduces either shape, per #1808's fix
 * idea. It is a lint on migration SHAPE, not a claim about whether any of the
 * six historical files ever caused a measurable production stall — that
 * requires Neon slow-query logs this repo cannot read.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const MIGRATIONS_DIR = join(__dirname, '../../packages/database/prisma/migrations');

const GRANDFATHERED = new Set([
  '20260430010000_cart_last_activity_and_store_pages_rls', // #963
  '20260512070000_add_reviews', // #1808
  '20260525120100_default_bot_service_menu', // #963
  '20260622000000_cart_item_null_variant_unique', // #963
  '20260720000000_order_refund_reversed_at', // #963 / #1808
  '20260808120000_fk_only_indexes', // #1012
]);

/** Large/hot tables where an unbounded UPDATE risks a boot-time lock stall. */
const HOT_TABLES = ['orders', 'products', 'carts', 'cart_items'];

function stripComments(sql: string): string {
  return sql.replace(/--.*$/gm, '');
}

/** Table names touched by an `UPDATE "<table>"` DML statement (quoted
 *  identifier only, so `ON UPDATE CASCADE` FK clauses never match). */
function updatedTables(sql: string): string[] {
  return [...sql.matchAll(/UPDATE\s+"(\w+)"/gi)].map(m => m[1].toLowerCase());
}

/** Table names that get an `ALTER COLUMN ... SET NOT NULL` in this file. */
function setNotNullTables(sql: string): Set<string> {
  return new Set(
    [
      ...sql.matchAll(/ALTER\s+TABLE\s+"(\w+)"\s+ALTER\s+COLUMN\s+"[^"]+"\s+SET\s+NOT\s+NULL/gi),
    ].map(m => m[1].toLowerCase())
  );
}

export function migrationLockFindings(sql: string): string[] {
  const body = stripComments(sql);
  const updated = updatedTables(body);
  const notNull = setNotNullTables(body);
  const findings = new Set<string>();

  for (const table of updated) {
    if (notNull.has(table)) {
      findings.add(
        `backfill UPDATE "${table}" is followed by ALTER COLUMN ... SET NOT NULL on "${table}" in the same migration`
      );
    }
    if (HOT_TABLES.includes(table)) {
      findings.add(`UPDATE "${table}" — a hot/large table; bound it by id or run it out-of-band`);
    }
  }
  return [...findings];
}

function migrationDirs(): string[] {
  return readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => d.name);
}

describe('migration lock-safety (#963 / #1012 / #1808)', () => {
  it('every grandfathered migration still exists — the allowlist has not gone stale', () => {
    const present = new Set(migrationDirs());
    for (const dir of GRANDFATHERED) {
      expect(present.has(dir), `${dir} no longer exists on disk`).toBe(true);
    }
  });

  it('no NEW migration outside the grandfathered set reintroduces the backfill+lock pattern', () => {
    const offenders: Record<string, string[]> = {};
    for (const dir of migrationDirs()) {
      if (GRANDFATHERED.has(dir)) continue;
      const file = join(MIGRATIONS_DIR, dir, 'migration.sql');
      if (!existsSync(file)) continue;
      const findings = migrationLockFindings(readFileSync(file, 'utf8'));
      if (findings.length > 0) offenders[dir] = findings;
    }
    expect(offenders).toEqual({});
  });

  it('mutation proof — the detector actually fires on the known-bad shape', () => {
    const backfillThenNotNull = `
      UPDATE "reviews" SET "body" = COALESCE("comment", '') WHERE "body" IS NULL;
      ALTER TABLE "reviews" ALTER COLUMN "body" SET NOT NULL;
    `;
    expect(migrationLockFindings(backfillThenNotNull).length).toBeGreaterThan(0);

    const unboundedHotTableUpdate = `UPDATE "orders" SET "delivered_at" = "updated_at" WHERE "status" = 'delivered';`;
    expect(migrationLockFindings(unboundedHotTableUpdate).length).toBeGreaterThan(0);

    // A benign, non-hot-table, no-rewrite migration must NOT be flagged.
    const benign = `CREATE INDEX IF NOT EXISTS "widgets_store_id_idx" ON "widgets" ("store_id");`;
    expect(migrationLockFindings(benign)).toEqual([]);

    // `ON UPDATE CASCADE` in a foreign key clause is not a DML UPDATE.
    const fkClause = `ALTER TABLE "reviews" ADD CONSTRAINT "reviews_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;`;
    expect(migrationLockFindings(fkClause)).toEqual([]);
  });
});
