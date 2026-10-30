// Small store-side statements the background jobs need (INFRA-CF-1, Ruling CF-JOBS-3): a job on a store that lives on its
// Durable Object cannot reach `payment_events`, `orders` stamps or the ledger totals through the read client, so each is one
// named money operation. Every statement is scoped by `store_id` taken from the DO (never from the caller).
import { MoneyError, type SyncSql } from './sync-sql';
import { addPaymentEvent } from './payments';

const str = (v: unknown, what: string): string => {
  if (typeof v !== 'string' || v.length === 0 || v.length > 128)
    throw new MoneyError('BAD_ARGS', what, 400);
  return v;
};

/**
 * Append one audit row to a payment's timeline (`recordPaymentEvent`). The payment must belong to this store and to the
 * named order, so a job cannot write a row against another store's payment.
 */
export function recordPaymentEventOp(
  db: SyncSql,
  storeId: string,
  a: Record<string, unknown>
): { recorded: true } {
  const paymentId = str(a.paymentId, 'paymentId');
  const orderId = str(a.orderId, 'orderId');
  const eventType = str(a.eventType, 'eventType');
  // `payments` carries no store column: it is scoped through its order
  const p = db.all(
    'SELECT p.id FROM payments p JOIN orders o ON o.id = p.order_id WHERE p.id = ? AND p.order_id = ? AND o.store_id = ?',
    [paymentId, orderId, storeId]
  )[0];
  if (!p) throw new MoneyError('PAYMENT_NOT_FOUND', 'payment not found', 404);
  addPaymentEvent(db, {
    storeId,
    paymentId,
    orderId,
    eventType,
    from: typeof a.fromStatus === 'string' ? a.fromStatus : null,
    to: typeof a.toStatus === 'string' ? a.toStatus : null,
    provider: typeof a.provider === 'string' ? a.provider : null,
    details: (a.details as Record<string, unknown> | undefined) ?? {},
    now: Date.now(),
  });
  return { recorded: true };
}

/**
 * Stamp "this checkout was abandoned at the gateway" exactly once: only while the order is still unpaid and unstamped
 * (the sweep's own guard). `stamped` is false when a payment or an earlier tick got there first.
 */
export function abandonStampOp(
  db: SyncSql,
  storeId: string,
  a: Record<string, unknown>
): { stamped: boolean } {
  const orderId = str(a.orderId, 'orderId');
  const r = db.run(
    "UPDATE orders SET payment_gateway_abandoned_at = ?1 WHERE id = ?2 AND store_id = ?3 AND payment_status = 'unpaid' AND payment_gateway_abandoned_at IS NULL",
    [Date.now(), orderId, storeId]
  );
  return { stamped: r.changes > 0 };
}

/** Sum of posted debits and credits of this store: the trial balance the daily close compares (Postgres: the raw SUM). */
export function trialBalanceOp(db: SyncSql, storeId: string): { debit: number; credit: number } {
  const r = db.all(
    `SELECT COALESCE(SUM(l.debit), 0) AS d, COALESCE(SUM(l.credit), 0) AS c
       FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id
      WHERE e.store_id = ? AND e.status = 'posted'`,
    [storeId]
  )[0];
  return { debit: Number(r?.d ?? 0), credit: Number(r?.c ?? 0) };
}

/** Revenue-side GL credits (sales 4000, 4010, tax payable 2100) posted since `sinceMs`: the period reconciliation's GL half. */
export function periodGlCreditsOp(
  db: SyncSql,
  storeId: string,
  a: Record<string, unknown>
): { total: number } {
  if (typeof a.sinceMs !== 'number' || !Number.isFinite(a.sinceMs))
    throw new MoneyError('BAD_ARGS', 'sinceMs', 400);
  const r = db.all(
    `SELECT COALESCE(SUM(l.credit), 0) AS total
       FROM journal_lines l
       JOIN journal_entries e ON e.id = l.entry_id
       JOIN accounts a ON a.id = l.account_id
      WHERE e.store_id = ? AND e.status = 'posted' AND e.posted_at >= ? AND a.code IN ('4000', '4010', '2100')`,
    [storeId, a.sinceMs]
  )[0];
  return { total: Number(r?.total ?? 0) };
}
