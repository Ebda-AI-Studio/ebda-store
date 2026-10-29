// What the cutover does with EVERY table the Cloudflare schema (and the StoreDO at run time) holds.
// The plan (scripts/cf/lib/plan.mjs) maps every Postgres-backed table by itself, because it is generated from the
// same generator as the schema. This file owns the rest: the tables that have NO Postgres twin, each with an explicit
// "what must be true at cutover" rule that verify-store.mjs checks with row counts AND sha256 checksums, and the
// tables the StoreDO creates lazily at run time. packages/cf-migrate/test/coverage.test.ts fails when a table exists
// that is in neither place, so a new table cannot reach the cutover unmapped (Ruling CUTOVER-5).
import { TableDigest } from './canon.mjs';

/**
 * Cloudflare-only tables of the generated schema (no Postgres source). Key = `<db>:<table>`.
 * `acceptable`: the row sets that are correct right after the import, as arrays of rows aligned with the table's
 * columns (plan order). verify compares the target's count + digest with each; any one equal is a pass.
 */
export const CF_ONLY_TABLES = {
  'store-do:commerce_outcomes': {
    how: 'starts-empty',
    why: 'CI-1 capture rows are written by live traffic only; Postgres never had them',
    acceptable: [[]],
  },
  'store-do:d1_outbox': {
    how: 'starts-empty',
    why: 'DO-to-D1 directory outbox; rows exist only once the DO is live',
    acceptable: [[]],
  },
  'store-do:do_flags': {
    how: 'flags-down',
    why: 'the import raises do_flags.gold_reprice inside its own transaction and clears it; nothing else may be set',
    acceptable: [[], [['gold_reprice', 0]]],
  },
  'd1:entity_index': {
    how: 'derived',
    why: 'rebuilt from the store tables (orders, payments, shipments, customers, returns); verified against them',
    acceptable: null,
  },
  'd1:platform_audit_log': {
    how: 'starts-empty',
    why: 'platform audit trail starts with the first live admin action; Postgres had no such table',
    acceptable: [[]],
  },
};

/**
 * Tables the StoreDO creates at run time (not in the generated DDL). They are never imported: a marker is only
 * meaningful for a request that happened on the DO, and the DO has served none before the seal. `erasure` says how
 * personal data in them goes away: `ttl` = purged by the writer after 24 h; `derived` = rebuilt from rows that are
 * erased through their own tables; `no-pii` = counters / state with no subject data.
 */
export const DO_RUNTIME_TABLES = {
  _migrations: { erasure: 'no-pii', why: 'schema migration bookkeeping' },
  _identity: { erasure: 'no-pii', why: 'the one-store binding of this DO' },
  _idempotency: {
    erasure: 'ttl',
    why: 'keyed write replay results, purged after 24 h (rpc/writes.ts)',
  },
  _stock_ops: { erasure: 'ttl', why: 'keyed stock operation markers (do/stock-ops.ts)' },
  _money_ops: { erasure: 'ttl', why: 'keyed money operation markers (do/money-ops.ts)' },
  payment_event_log: {
    erasure: 'no-pii',
    why: 'provider event ids already applied; also a generated table',
  },
  search_dirty: { erasure: 'derived', why: 'queue of rows to re-index' },
  product_vector_state: { erasure: 'derived', why: 'embedding bookkeeping, rebuilt from products' },
  vector_usage: { erasure: 'no-pii', why: 'Workers AI spend counter per day' },
};
/** FTS virtual tables and their shadow tables: derived search state, re-marked dirty by triggers on restore */
export const DO_DERIVED_TABLE = /^(product_search_fts|customer_search_fts)/;

/** true when a table of a live StoreDO is accounted for by the plan, the CF-only rules or the runtime registry */
export function knownDoTable(name, planNames) {
  return (
    planNames.has(name) ||
    name in DO_RUNTIME_TABLES ||
    DO_DERIVED_TABLE.test(name) ||
    name.startsWith('cf_') ||
    name.startsWith('sqlite_') ||
    name.startsWith('__miniflare') // local workerd's own DO bookkeeping (rehearsal only)
  );
}

/** the `{count, digest}` each acceptable row set produces, for a plan table (columns in plan order) */
export async function acceptableDigests(table, rule) {
  if (!rule?.acceptable) return [];
  const names = table.columns.map(c => c.col);
  const out = [];
  for (const rows of rule.acceptable) {
    const d = new TableDigest();
    for (const r of rows) await d.add(names, r, table.pk);
    out.push(await d.finish());
  }
  return out;
}
