// Store-side statements for the non-money background jobs (INFRA-CF-1, Ruling CF-JOBS-4). Same rules as job-ops.ts: each is
// scoped by the `store_id` the DO holds, never by the caller.
import { MoneyError, type SyncSql } from './sync-sql';

/** The order columns a job may stamp once. A closed list: the caller names the stamp, never a column. */
const ORDER_STAMPS: Readonly<Record<string, string>> = {
  reviewRequestSentAt: 'review_request_sent_at',
};

/**
 * Stamp an order "this job has run for it" exactly once: only while the column is still empty. `stamped` is false when an
 * earlier run (a retry, a double delivery) got there first, so the second run can tell it lost.
 */
export function orderStampOp(
  db: SyncSql,
  storeId: string,
  a: Record<string, unknown>
): { stamped: boolean } {
  const column = typeof a.stamp === 'string' ? ORDER_STAMPS[a.stamp] : undefined;
  if (!column) throw new MoneyError('BAD_ARGS', 'stamp', 400);
  if (typeof a.orderId !== 'string' || a.orderId.length === 0 || a.orderId.length > 128)
    throw new MoneyError('BAD_ARGS', 'orderId', 400);
  const r = db.run(
    `UPDATE orders SET ${column} = ?1 WHERE id = ?2 AND store_id = ?3 AND ${column} IS NULL`,
    [Date.now(), a.orderId, storeId]
  );
  return { stamped: r.changes > 0 };
}
