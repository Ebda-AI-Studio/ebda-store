// Operator metrics on the StoreDO (Ruling DO-METRICS-1): read-only, count-only, allow-listed. ONLY a metric NAME crosses the RPC; the SQL is
// a constant below, so no caller can send SQL text. Every metric is one single-statement SELECT returning ONE integer column `n`.
// The runtime cannot enforce read-only (no `query_only`, `sql.exec` runs every statement of a multi-statement string), so enforcement is:
// this constant table + tests/static guard (packages/repo/test/do-metrics.test.ts: one statement, SELECT only, no write/DDL keyword, an index
// per table read) + the numbers-only return + the rollback guard in `runDoMetric` (a write inside the metric throws and rolls back).
import { MoneyError, type SyncSql } from './sync-sql';

export interface DoMetricDef {
  /** One statement, SELECT only, ONE row with ONE integer column `n`. `?1` is not used: a metric takes no argument. */
  sql: string;
  /** Why this exists and what a non-zero value means (shown to the operator). */
  doc: string;
}

export const DO_METRICS = {
  /** Posted journal entries whose debits and credits differ: the books do not balance (track 1). */
  journal_unbalanced: {
    doc: 'Posted journal entries where total debit differs from total credit.',
    sql: `SELECT COUNT(*) AS n FROM (
            SELECT e.id FROM journal_entries e JOIN journal_lines l ON l.entry_id = e.id
            WHERE e.status = 'posted' GROUP BY e.id HAVING SUM(l.debit) <> SUM(l.credit))`,
  },
  /** Paid orders with no sale entry: the journal reconcile has not (yet) repaired them (track 1). */
  journal_unrepaired: {
    doc: "Paid orders that have no 'order' sale journal entry (the reconcile has not repaired them yet).",
    sql: `SELECT COUNT(*) AS n FROM orders o WHERE o.payment_status = 'paid'
            AND NOT EXISTS (SELECT 1 FROM journal_entries e WHERE e.source = 'order' AND e.source_id = o.id)`,
  },
  /** Active push subscriptions of the store (track 4). */
  push_subscriptions_active: {
    doc: 'Rows in push_subscriptions (devices that can currently receive a push).',
    sql: 'SELECT COUNT(*) AS n FROM push_subscriptions',
  },
} as const satisfies Record<string, DoMetricDef>;

export type DoMetricName = keyof typeof DO_METRICS;
export const DO_METRIC_NAMES = Object.keys(DO_METRICS) as DoMetricName[];

/** Run one allow-listed metric on this store's database. `metrics` is injectable for tests only; production passes DO_METRICS. */
export function runDoMetric(
  db: SyncSql,
  a: Record<string, unknown>,
  metrics: Record<string, DoMetricDef> = DO_METRICS
): { n: number } {
  const name = a.name;
  if (typeof name !== 'string' || !Object.prototype.hasOwnProperty.call(metrics, name))
    throw new MoneyError('BAD_ARGS', 'unknown metric', 400);
  const def = metrics[name]!;
  // Defence in depth: if a metric ever wrote, throw so the transaction rolls EVERYTHING back (total_changes counts rows written).
  return db.transactionSync(() => {
    const before = Number(db.all('SELECT total_changes() AS c', [])[0]?.c ?? 0);
    const rows = db.all(def.sql, []);
    const after = Number(db.all('SELECT total_changes() AS c', [])[0]?.c ?? 0);
    if (after !== before) throw new MoneyError('METRIC_WROTE', 'a metric must not write', 500);
    const n = Number(rows[0]?.n);
    if (rows.length !== 1 || !Number.isSafeInteger(n) || Object.keys(rows[0]!).join() !== 'n')
      throw new MoneyError('METRIC_SHAPE', 'a metric returns one integer column n', 500);
    return { n };
  });
}
