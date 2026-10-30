// Which live-side changes a rollback replay may leave behind, and which it must refuse (Opus I2, Ruling CF-OPUS-2).
// A table with changes after the flip is one of: replayed into Postgres (bound plan table), DISCARDABLE (derived or
// bookkeeping state that carries no business fact, listed explicitly below), or LOSSY (everything else, including the
// Cloudflare-only tables that hold real facts: instapay_order_receipts, payment_event_log, erasure_ledger, ...).
// A lossy table refuses the rollback unless --accept-data-loss names it. A table nobody listed is lossy by default.
import { DO_DERIVED_TABLE } from '../../../packages/cf-migrate/src/coverage.mjs';

export const DISCARDABLE_CF_ONLY = new Set([
  'entity_index', // rebuilt from the store tables
  'platform_audit_log', // Postgres has no such table; the trail starts with the first live admin action
  '_migrations',
  '_identity',
  '_idempotency', // keyed write replay results, 24 h
  '_stock_ops',
  '_money_ops', // keyed operation markers, 24 h
  'search_dirty',
  'product_vector_state', // derived, rebuilt from products
  'vector_usage', // Workers AI spend counter
]);

/** the Cloudflare-only tables whose changes carry a business fact: named so a test pins each one */
export const CF_ONLY_FACT_TABLES = [
  'instapay_order_receipts',
  'payment_event_log',
  'erasure_ledger',
];

const count = x => (x ? x.added.length + x.changed.length + x.deleted.length : 0);

export function isDiscardable(name) {
  return (
    DISCARDABLE_CF_ONLY.has(name) ||
    DO_DERIVED_TABLE.test(name) ||
    name.startsWith('cf_') ||
    name.startsWith('sqlite_') ||
    name.startsWith('__miniflare')
  );
}

/**
 * @param tag e.g. store slug or 'D1'
 * @param diffTables { table: {added, changed, deleted} } from __diff / the D1 baseline
 * @param replayed Set of table names the replay binds to a Postgres table
 * @returns lossy descriptions for every changed table that is neither replayed nor discardable
 */
export function unreplayedLoss(tag, diffTables, replayed) {
  const lossy = [];
  for (const [name, x] of Object.entries(diffTables ?? {})) {
    const n = count(x);
    if (!n || replayed.has(name) || isDiscardable(name)) continue;
    lossy.push(
      `${tag}.${name}: ${n} change(s) on a Cloudflare-only table, no Postgres home to replay into`
    );
  }
  return lossy;
}
