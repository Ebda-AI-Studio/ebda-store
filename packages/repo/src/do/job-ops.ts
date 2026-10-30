// Small store-side statements the background jobs need (INFRA-CF-1, Ruling CF-JOBS-4): a job on a store that lives on its
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

/**
 * The reorder scan's first transaction (Postgres: two UPDATEs and a COUNT): expire open suggestions older than `thresholdMs`
 * and those whose unit no longer exists (a product-level row for a product that has variants, a row of a disabled variant).
 * Returns the number expired and the count of open PO lines with no variant on a variant product (logged, issue 2345).
 */
export function reorderExpireOp(
  db: SyncSql,
  storeId: string,
  a: Record<string, unknown>
): { expired: number; variantlessOpenPoLines: number } {
  if (typeof a.thresholdMs !== 'number' || !Number.isFinite(a.thresholdMs))
    throw new MoneyError('BAD_ARGS', 'thresholdMs', 400);
  return db.transactionSync(() => {
    const stale = db.run(
      "UPDATE reorder_suggestions SET status = 'expired' WHERE store_id = ? AND status = 'open' AND scanned_at < ?",
      [storeId, a.thresholdMs]
    ).changes;
    const gone = db.run(
      `UPDATE reorder_suggestions SET status = 'expired'
        WHERE store_id = ? AND status = 'open' AND (
          (variant_id IS NULL AND EXISTS (SELECT 1 FROM product_variants pv WHERE pv.product_id = reorder_suggestions.product_id))
          OR (variant_id IS NOT NULL AND EXISTS (SELECT 1 FROM product_variants pv WHERE pv.id = reorder_suggestions.variant_id AND pv.is_active = 0))
        )`,
      [storeId]
    ).changes;
    const v = db.all(
      `SELECT COUNT(*) AS n FROM purchase_order_items i JOIN purchase_orders p ON p.id = i.po_id
        WHERE p.store_id = ? AND p.status IN ('sent', 'partial') AND i.variant_id IS NULL AND i.qty > i.qty_received
          AND EXISTS (SELECT 1 FROM product_variants pv WHERE pv.product_id = i.product_id)`,
      [storeId]
    )[0];
    return { expired: stale + gone, variantlessOpenPoLines: Number(v?.n ?? 0) };
  });
}

interface ReorderRow {
  productId: string;
  variantId: string | null;
  suggestedQty: number;
  velocity7d: number;
  velocity28d: number;
  onHand: number;
  onOrder: number;
  openBacklog: number;
  urgencyDays: number;
  supplierId: string | null;
  reasoningEn: string;
  reasoningAr: string | null;
}

/**
 * The reorder scan's third phase: ONE open suggestion per unit. The latest open row of the unit is updated (and re-stamped
 * with this scan's time), else a row is created. Returns how many units were written; a unit that cannot be written (a
 * deleted product) is skipped, like the Postgres savepoint.
 */
export function reorderUpsertOp(
  db: SyncSql,
  storeId: string,
  a: Record<string, unknown>
): { upserted: number } {
  if (typeof a.scannedAtMs !== 'number' || !Array.isArray(a.items) || a.items.length > 200)
    throw new MoneyError('BAD_ARGS', 'items', 400);
  const scannedAt = a.scannedAtMs;
  let upserted = 0;
  for (const raw of a.items as ReorderRow[]) {
    try {
      db.transactionSync(() => {
        const vid = raw.variantId ?? null;
        const existing = db.all(
          `SELECT id FROM reorder_suggestions WHERE store_id = ? AND product_id = ? AND ${vid === null ? 'variant_id IS NULL' : 'variant_id = ?'} AND status = 'open' ORDER BY scanned_at DESC LIMIT 1`,
          vid === null ? [storeId, raw.productId] : [storeId, raw.productId, vid]
        )[0];
        const vals = [
          raw.suggestedQty,
          raw.velocity7d,
          raw.velocity28d,
          raw.onHand,
          raw.onOrder,
          raw.openBacklog,
          raw.urgencyDays,
          raw.supplierId ?? null,
          raw.reasoningEn,
          raw.reasoningAr ?? null,
          scannedAt,
        ];
        if (existing) {
          db.run(
            `UPDATE reorder_suggestions SET suggested_qty = ?, velocity_7d = ?, velocity_28d = ?, on_hand = ?, on_order = ?, open_backlog = ?, urgency_days = ?, supplier_id = ?, reasoning_en = ?, reasoning_ar = ?, status = 'open', scanned_at = ? WHERE id = ? AND store_id = ?`,
            [...vals, existing.id as string, storeId]
          );
        } else {
          db.run(
            `INSERT INTO reorder_suggestions (id, store_id, product_id, variant_id, suggested_qty, velocity_7d, velocity_28d, on_hand, on_order, open_backlog, urgency_days, supplier_id, reasoning_en, reasoning_ar, status, scanned_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?)`,
            [crypto.randomUUID(), storeId, raw.productId, vid, ...vals]
          );
        }
      });
      upserted += 1;
    } catch {
      // a unit whose product or supplier is gone: skipped, as the Postgres savepoint does
    }
  }
  return { upserted };
}
