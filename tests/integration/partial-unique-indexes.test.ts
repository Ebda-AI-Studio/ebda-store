/**
 * Every partial unique index the migrations create still exists (#1462).
 *
 * Prisma has no DSL for a partial index, so these live ONLY in raw migration
 * SQL. schema.prisma does not know about them, which means `npm run db:push`
 * (a documented command) force-syncs them AWAY without a word, and so would a
 * restore to a point before their migration. Several are money guarantees:
 *
 *   - `loyalty_transactions_earn_purchase_unique` — one points award per order;
 *   - `loyalty_transactions_reversal_tag_unique` — one refund-revoke /
 *     redeem-recredit per order, the constraint the reversal paths' P2002
 *     handlers exist to catch. Without it those handlers are dead code and the
 *     double-reversal race is open;
 *   - `journal_entries_store_source_source_id_unique` — one journal entry per
 *     source document.
 *
 * Nothing asserted any of them existed, so losing one would leave a green
 * suite and code comments still claiming the guarantee. The list is DERIVED
 * from the migration files (net of any later DROP INDEX), so a new partial
 * unique index is covered the day it is written, not when someone remembers.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { prisma } from '@ebda/database';

const MIGRATIONS = path.resolve(__dirname, '../../packages/database/prisma/migrations');

/** Partial unique indexes the migration history leaves in place, by name. */
function partialUniqueIndexesFromMigrations(): Map<string, string> {
  const live = new Map<string, string>();
  const dirs = fs
    .readdirSync(MIGRATIONS)
    .filter(d => fs.statSync(path.join(MIGRATIONS, d)).isDirectory())
    .sort();
  for (const dir of dirs) {
    const file = path.join(MIGRATIONS, dir, 'migration.sql');
    if (!fs.existsSync(file)) continue;
    const sql = fs.readFileSync(file, 'utf8').replace(/--.*$/gm, '');
    for (const stmt of sql.split(';')) {
      const created = stmt.match(
        /CREATE\s+UNIQUE\s+INDEX\s+(?:CONCURRENTLY\s+)?(?:IF\s+NOT\s+EXISTS\s+)?"?(\w+)"?\s+ON\s+(?:"?public"?\.)?"?(\w+)"?[\s\S]*?\bWHERE\b/i
      );
      if (created) {
        live.set(created[1], created[2]);
        continue;
      }
      const dropped = stmt.match(
        /DROP\s+INDEX\s+(?:CONCURRENTLY\s+)?(?:IF\s+EXISTS\s+)?(?:"?public"?\.)?"?(\w+)"?/i
      );
      if (dropped) live.delete(dropped[1]);
    }
  }
  return live;
}

async function indexDefs(): Promise<Map<string, { table: string; def: string }>> {
  const rows = await prisma.$queryRaw<
    Array<{ indexname: string; tablename: string; indexdef: string }>
  >`SELECT indexname, tablename, indexdef FROM pg_indexes WHERE schemaname = 'public'`;
  return new Map(rows.map(r => [r.indexname, { table: r.tablename, def: r.indexdef }]));
}

describe('partial unique indexes declared only in migration SQL', () => {
  it('the derivation finds them — positive control', () => {
    const expected = partialUniqueIndexesFromMigrations();
    expect(expected.get('loyalty_transactions_earn_purchase_unique')).toBe('loyalty_transactions');
    expect(expected.get('loyalty_transactions_reversal_tag_unique')).toBe('loyalty_transactions');
    expect(expected.size).toBeGreaterThanOrEqual(9);
  });

  it('every one exists, on its table, still UNIQUE and still partial', async () => {
    const defs = await indexDefs();
    const problems: string[] = [];
    for (const [name, table] of partialUniqueIndexesFromMigrations()) {
      const found = defs.get(name);
      if (!found) problems.push(`${name}: missing`);
      else if (found.table !== table) problems.push(`${name}: on ${found.table}, not ${table}`);
      else if (!/^CREATE UNIQUE INDEX/i.test(found.def)) problems.push(`${name}: no longer UNIQUE`);
      else if (!/\sWHERE\s/i.test(found.def)) problems.push(`${name}: no longer partial`);
    }
    expect(problems, 'a db:push or an old restore drops these silently').toEqual([]);
  });

  it('the loyalty reversal guard keeps both of its tag predicates', async () => {
    const def = (await indexDefs()).get('loyalty_transactions_reversal_tag_unique')?.def ?? '';
    // A narrowed predicate would leave one reversal kind unguarded while the
    // index still "exists".
    expect(def).toContain('refund-revoke:%');
    expect(def).toContain('redeem-recredit:%');
    expect(def).toMatch(/\(store_id, order_id, description\)/);
  });

  it('the loyalty earn guard is one award per (store, order) for earn_purchase', async () => {
    const def = (await indexDefs()).get('loyalty_transactions_earn_purchase_unique')?.def ?? '';
    expect(def).toMatch(/\(store_id, order_id\)/);
    expect(def).toContain('earn_purchase');
  });
});
