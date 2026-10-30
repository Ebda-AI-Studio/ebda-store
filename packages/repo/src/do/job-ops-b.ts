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

const FX_SCALE = 100_000_000;
const CASH_BANK_PREFIX = '10';

/**
 * A DRAFT expense (the receipt-OCR job): the accounts and the supplier must be this store's, the paid-from account a cash or
 * bank asset (code `10..`, the same guard `createExpense` applies), the number `EXP-<year>-<6 digits>` is claimed from the
 * store's own sequence, and the row (with the OCR metadata, when the job read one) lands in the same section. The Worker computes
 * the amounts (`total = amount + taxAmount`, the base-currency conversion) exactly as the Postgres twin does; nothing is posted
 * to the ledger here (a draft has no journal).
 */
export function expenseDraftOp(
  db: SyncSql,
  storeId: string,
  a: Record<string, unknown>
): { expenseId: string; expenseNumber: string } {
  const text = (v: unknown, what: string, max = 4000): string | null => {
    if (v === undefined || v === null) return null;
    if (typeof v !== 'string' || v.length > max) throw new MoneyError('BAD_ARGS', what, 400);
    return v;
  };
  const id = (v: unknown, what: string): string => {
    if (typeof v !== 'string' || v.length === 0 || v.length > 128)
      throw new MoneyError('BAD_ARGS', what, 400);
    return v;
  };
  const amount = intArg(a.amount, 'amount', 0, 2_000_000_000);
  const taxAmount = intArg(a.taxAmount, 'taxAmount', 0, 2_000_000_000);
  const total = intArg(a.total, 'total', 0, 2_000_000_000);
  if (total !== amount + taxAmount) throw new MoneyError('BAD_ARGS', 'total', 400);
  const originalAmount = intArg(a.originalAmount, 'originalAmount', 0, 2_000_000_000);
  const expenseDate = intArg(a.expenseDate, 'expenseDate', 0, Number.MAX_SAFE_INTEGER);
  const fxRate = a.fxRate;
  if (typeof fxRate !== 'number' || !Number.isFinite(fxRate) || fxRate <= 0)
    throw new MoneyError('INVALID_FX_RATE', 'fxRate must be a finite positive number.', 422);
  const currency = text(a.currency, 'currency', 8);
  if (!currency) throw new MoneyError('BAD_ARGS', 'currency', 400);
  const expenseAccountId = id(a.expenseAccountId, 'expenseAccountId');
  const paidFromAccountId = id(a.paidFromAccountId, 'paidFromAccountId');
  const supplierId = a.supplierId == null ? null : id(a.supplierId, 'supplierId');

  const paidFrom = db.all('SELECT code, type FROM accounts WHERE id = ? AND store_id = ?', [
    paidFromAccountId,
    storeId,
  ])[0];
  if (!paidFrom)
    throw new MoneyError('INVALID_PAID_FROM', 'Paid-from account not found for this store.', 400);
  if (paidFrom.type !== 'asset' || !String(paidFrom.code).startsWith(CASH_BANK_PREFIX))
    throw new MoneyError(
      'INVALID_PAID_FROM',
      'Paid-from account must be a cash or bank account (codes 1000–1099).',
      400
    );
  if (
    !db.all('SELECT 1 FROM accounts WHERE id = ? AND store_id = ?', [expenseAccountId, storeId])[0]
  )
    throw new MoneyError('ACCOUNT_NOT_FOUND', 'Expense account not found for this store.', 400);
  if (
    supplierId &&
    !db.all('SELECT 1 FROM suppliers WHERE id = ? AND store_id = ?', [supplierId, storeId])[0]
  )
    throw new MoneyError('SUPPLIER_NOT_FOUND', 'Supplier not found for this store.', 400);

  const now = Date.now();
  db.run(
    `INSERT INTO sequences (store_id, kind, next, updated_at) VALUES (?1, 'expense', 2, ?2)
     ON CONFLICT (store_id, kind) DO UPDATE SET next = sequences.next + 1, updated_at = ?2`,
    [storeId, now]
  );
  const n = Number(
    db.all("SELECT next - 1 AS n FROM sequences WHERE store_id = ? AND kind = 'expense'", [
      storeId,
    ])[0].n
  );
  const expenseNumber = `EXP-${new Date(now).getUTCFullYear()}-${String(n).padStart(6, '0')}`;
  const expenseId = crypto.randomUUID();
  const ocr = a.ocr as Record<string, unknown> | undefined;
  db.run(
    `INSERT INTO expenses (id, store_id, expense_number, supplier_id, expense_account_id, paid_from_account_id, amount, tax_amount,
       total, currency, fx_rate, original_amount, expense_date, status, receipt_image_url, notes, notes_ar, created_by,
       ocr_json, category_ai_confidence, ocr_model_version, ocr_processed_at, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, 'draft', ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?22)`,
    [
      expenseId,
      storeId,
      expenseNumber,
      supplierId,
      expenseAccountId,
      paidFromAccountId,
      amount,
      taxAmount,
      total,
      currency,
      Math.round(fxRate * FX_SCALE),
      originalAmount,
      expenseDate,
      text(a.receiptImageUrl, 'receiptImageUrl', 2048),
      text(a.notes, 'notes'),
      text(a.notesAr, 'notesAr'),
      text(a.createdBy, 'createdBy', 128),
      ocr ? JSON.stringify(ocr.json ?? null) : null,
      ocr && typeof ocr.confidence === 'number' ? ocr.confidence : null,
      ocr ? text(ocr.modelVersion, 'modelVersion', 128) : null,
      ocr && typeof ocr.processedAtMs === 'number' ? ocr.processedAtMs : null,
      now,
    ]
  );
  return { expenseId, expenseNumber };
}
