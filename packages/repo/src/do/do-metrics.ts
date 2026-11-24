// Operator metrics on the StoreDO (Ruling DO-METRICS-1): read-only, count-only, allow-listed. ONLY a metric NAME crosses the RPC; the SQL is
// a constant below, so no caller can send SQL text. Every metric is one single-statement SELECT returning ONE integer column `n`.
// The runtime cannot enforce read-only (no `query_only`, `sql.exec` runs every statement of a multi-statement string), so enforcement is:
// this constant table + tests/static guard (packages/repo/test/do-metrics.test.ts: one statement, SELECT only, no write/DDL keyword, an index
// per table read) + the numbers-only return + the rollback guard in `runDoMetric` (a write inside the metric throws and rolls back).
import { MoneyError, type SyncSql } from './sync-sql';
import {
  JOURNAL_REPAIR_GRACE_MINUTES_DEFAULT,
  JOURNAL_REPAIR_MAX_AGE_HOURS_DEFAULT,
} from '../../../shared/src/journal-reconcile';

const WINDOW_MS = JOURNAL_REPAIR_MAX_AGE_HOURS_DEFAULT * 3_600_000;
const JOURNAL_GRACE_MS = JOURNAL_REPAIR_GRACE_MINUTES_DEFAULT * 60_000;

export interface DoMetricDef {
  /** One statement, SELECT only, ONE row with ONE integer column `n`. `?1` is not used: a metric takes no argument. */
  sql: string;
  /** Why this exists and what a non-zero value means (shown to the operator). */
  doc: string;
}

const NOW_MS = "CAST(unixepoch('subsec') * 1000 AS INTEGER)";
/** #926's candidate set (count only) filtered by `paidWhere`; `t` has store_id and paid_at. One statement, no parameters. */
const UNREPAIRED_SQL = (paidWhere: string): string =>
  `SELECT COUNT(*) AS n FROM (
     SELECT o.id, o.store_id,
            COALESCE((SELECT MAX(p.paid_at) FROM payments p WHERE p.order_id = o.id AND p.status = 'completed'), o.created_at) AS paid_at
       FROM store_config c JOIN orders o ON o.store_id = c.store_id
      WHERE c.accounting_enabled = 1 AND o.deleted_at IS NULL AND o.payment_status = 'paid'
        AND o.status NOT IN ('cancelled', 'refunded') AND o.total > 0
        AND NOT EXISTS (SELECT 1 FROM journal_entries e WHERE e.store_id = o.store_id AND e.source = 'order' AND e.source_id = o.id)
   ) t WHERE ${paidWhere.replaceAll('NOW_MS', NOW_MS)}`;

export const DO_METRICS = {
  /** Posted journal entries whose debits and credits differ: the books do not balance (track 1). */
  journal_unbalanced: {
    doc: 'Posted journal entries where total debit differs from total credit.',
    sql: `SELECT COUNT(*) AS n FROM (
            SELECT e.id FROM journal_entries e JOIN journal_lines l ON l.entry_id = e.id
            WHERE e.status = 'posted' GROUP BY e.id HAVING SUM(l.debit) <> SUM(l.credit))`,
  },
  /**
   * Paid orders with no sale entry that the hourly repair WILL fix: paid between 72 h and 10 min ago (Ruling JOURNAL-RECONCILE-1, PR #926).
   * Exactly #926's candidate rules: accounting on for the store, order total > 0, not cancelled/refunded/deleted, "paid at" = the latest
   * completed payment's paid_at (else the order's created_at), no `order` sale entry of this store. The window and grace come from
   * packages/shared/src/journal-reconcile.ts, the single source #926's sweep should import (a DO has no env).
   */
  journal_unrepaired_in_window: {
    doc: "Paid orders (paid 10 min to 72 h ago) with no 'order' sale journal entry: the hourly repair will post them.",
    sql: UNREPAIRED_SQL(
      `t.paid_at >= (NOW_MS - ${WINDOW_MS}) AND t.paid_at < (NOW_MS - ${JOURNAL_GRACE_MS})`
    ),
  },
  /**
   * Same rules, paid MORE than 72 h ago and not before the store's first journal entry (the floor of journal.reconcile.stale: a store that
   * turned accounting on later is not "missing" its history). The repair no longer reaches these: a person must look.
   */
  journal_unrepaired_stale: {
    doc: "Paid orders (paid over 72 h ago, after the store's first journal entry) with no 'order' sale entry: needs a person.",
    sql: UNREPAIRED_SQL(
      `t.paid_at < (NOW_MS - ${WINDOW_MS}) AND t.paid_at >= (SELECT MIN(created_at) FROM journal_entries WHERE store_id = t.store_id)`
    ),
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
