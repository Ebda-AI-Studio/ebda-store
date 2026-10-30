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

const intArg = (v: unknown, what: string, min: number, max: number): number => {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max)
    throw new MoneyError('BAD_ARGS', what, 400);
  return v;
};

/**
 * Retention at 5 years (`order-anonymize-5y-monthly`): strip the personal snapshots of up to `limit` orders created before
 * `cutoffMs` whose address is not already `{"anonymized":true}`, oldest first. One statement, so a double run finds nothing
 * left to do (the marker makes a scrubbed order stop matching). The order row itself stays: it is the financial record.
 */
export function orderAnonymizeOp(
  db: SyncSql,
  storeId: string,
  a: Record<string, unknown>
): { anonymized: number } {
  const cutoffMs = intArg(a.cutoffMs, 'cutoffMs', 0, Number.MAX_SAFE_INTEGER);
  const limit = intArg(a.limit, 'limit', 1, 5000);
  const r = db.run(
    `UPDATE orders SET customer_id = NULL, shipping_address = '{"anonymized":true}', billing_address = '{"anonymized":true}',
       customer_notes = NULL, buyer_key = NULL, area_key = NULL
     WHERE id IN (
       SELECT id FROM orders WHERE store_id = ?1 AND created_at < ?2
         AND COALESCE(json_extract(shipping_address, '$.anonymized'), 0) != 1
       ORDER BY created_at ASC LIMIT ?3)
     AND store_id = ?1`,
    [storeId, cutoffMs, limit]
  );
  return { anonymized: r.changes };
}

/**
 * The last PAID sale of each product, in one grouped read (the dead-stock scan). A product with no paid sale is absent.
 * At most 90 ids per call (the DO binds 100 parameters).
 */
export function lastPaidSalesOp(
  db: SyncSql,
  storeId: string,
  a: Record<string, unknown>
): { sales: Record<string, number> } {
  const ids = a.productIds;
  if (!Array.isArray(ids) || ids.length > 90 || ids.some(i => typeof i !== 'string' || !i))
    throw new MoneyError('BAD_ARGS', 'productIds', 400);
  if (ids.length === 0) return { sales: {} };
  const rows = db.all(
    `SELECT oi.product_id AS product_id, MAX(o.created_at) AS last_sale
       FROM order_items oi JOIN orders o ON o.id = oi.order_id
      WHERE o.store_id = ? AND o.payment_status = 'paid' AND oi.product_id IN (${ids.map(() => '?').join(',')})
      GROUP BY oi.product_id`,
    [storeId, ...(ids as string[])]
  );
  return {
    sales: Object.fromEntries(rows.map(r => [r.product_id as string, Number(r.last_sale)])),
  };
}

/**
 * The store-side half of the monthly usage snapshot: the catalogue as it is now and the period's commerce, in the same
 * shape and with the same definitions as the Postgres collection query (net revenue = paid and not cancelled/refunded).
 * The AI-usage and product-view numbers live in the analytics tables and are read there.
 */
export function usageCountsOp(
  db: SyncSql,
  storeId: string,
  a: Record<string, unknown>
): Record<string, number> {
  const start = intArg(a.startMs, 'startMs', 0, Number.MAX_SAFE_INTEGER);
  const end = intArg(a.endMs, 'endMs', 0, Number.MAX_SAFE_INTEGER);
  const one = (sql: string, p: unknown[]): number =>
    Number((db.all(sql, p)[0] as Record<string, unknown>)?.n ?? 0);
  return {
    products: one('SELECT COUNT(*) AS n FROM products WHERE store_id = ? AND deleted_at IS NULL', [
      storeId,
    ]),
    productsActive: one(
      "SELECT COUNT(*) AS n FROM products WHERE store_id = ? AND deleted_at IS NULL AND status = 'active'",
      [storeId]
    ),
    variants: one(
      'SELECT COUNT(*) AS n FROM product_variants v JOIN products p ON p.id = v.product_id WHERE p.store_id = ? AND p.deleted_at IS NULL',
      [storeId]
    ),
    images: one(
      'SELECT COUNT(*) AS n FROM product_images i JOIN products p ON p.id = i.product_id WHERE p.store_id = ? AND p.deleted_at IS NULL',
      [storeId]
    ),
    categories: one('SELECT COUNT(*) AS n FROM categories WHERE store_id = ?', [storeId]),
    orders: one(
      'SELECT COUNT(*) AS n FROM orders WHERE store_id = ? AND created_at >= ? AND created_at < ?',
      [storeId, start, end]
    ),
    revenueFils: one(
      `SELECT COALESCE(SUM(total), 0) AS n FROM orders WHERE store_id = ? AND created_at >= ? AND created_at < ?
         AND payment_status = 'paid' AND status NOT IN ('cancelled', 'refunded')`,
      [storeId, start, end]
    ),
    customers: one(
      'SELECT COUNT(*) AS n FROM customers WHERE store_id = ? AND created_at >= ? AND created_at < ?',
      [storeId, start, end]
    ),
    sessionsProxy: one(
      `SELECT COUNT(*) AS n FROM carts c WHERE c.store_id = ? AND c.created_at >= ? AND c.created_at < ?
         AND NOT EXISTS (SELECT 1 FROM cart_items ci WHERE ci.cart_id = c.id)`,
      [storeId, start, end]
    ),
    cartsWithItems: one(
      `SELECT COUNT(*) AS n FROM carts c WHERE c.store_id = ? AND c.created_at >= ? AND c.created_at < ?
         AND EXISTS (SELECT 1 FROM cart_items ci WHERE ci.cart_id = c.id)`,
      [storeId, start, end]
    ),
  };
}
