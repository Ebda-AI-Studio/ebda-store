/**
 * Which StoreDO tables a backup covers. Dynamic (read from the live schema), not a hand list: the StoreDO now carries
 * the full generated cf-schema (122 tables), and a list typed here would silently omit the next table a migration adds.
 *
 * Excluded: SQLite/Cloudflare internals, the migration + identity bookkeeping (a restore target brings its own),
 * and DERIVED search state (FTS virtual tables and their shadow tables, the dirty queue, vector state): the triggers
 * re-mark every restored product/customer/order dirty, so the next search rebuilds the index from the rows.
 */
const EXCLUDED =
  /^(sqlite_|_cf_|_migrations$|_identity$|_idempotency$|search_dirty$|product_vector_state$|product_search_fts|customer_search_fts)/;

export interface SqlRead {
  exec(q: string, ...b: unknown[]): { toArray(): Array<Record<string, unknown>> };
}

/** Table names to back up, sorted: order does not matter for a restore (it defers foreign keys), it only has to be stable. */
export function storeTables(sql: SqlRead): string[] {
  return sql
    .exec("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .toArray()
    .map(r => r.name as string)
    .filter(n => !EXCLUDED.test(n));
}

/** `ORDER BY` for a deterministic export: the primary key (WITHOUT ROWID tables have no rowid), else rowid. */
export function exportOrder(sql: SqlRead, table: string): string {
  const pk = sql
    .exec(`PRAGMA table_info("${table.replace(/"/g, '""')}")`)
    .toArray()
    .filter(c => Number(c.pk) > 0)
    .sort((a, b) => Number(a.pk) - Number(b.pk))
    .map(c => `"${String(c.name).replace(/"/g, '""')}"`);
  return pk.length ? pk.join(', ') : 'rowid';
}
