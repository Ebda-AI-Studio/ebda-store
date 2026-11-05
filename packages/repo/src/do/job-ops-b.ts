// Store-side statements for the non-money background jobs (INFRA-CF-1, Ruling CF-JOBS-4). Same rules as job-ops.ts: each is
// scoped by the `store_id` the DO holds, never by the caller.
import { MoneyError, type SyncSql } from './sync-sql';
import {
  DEFAULT_DAILY_CAP,
  commitVectorWork,
  embedUsageToday,
  hasStaleVectors,
  vectorStatus,
  planVectorWork,
  quarantineVectorFailure,
  reserveEmbedTexts,
  type VectorWork,
  visibleVectorProductIds,
} from './search-vectors';

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
    productViews: one(
      'SELECT COALESCE(SUM(count), 0) AS n FROM product_daily_views WHERE store_id = ? AND date >= ? AND date < ?',
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

/**
 * An expense's status step (approve / post / reject), the DO twin of `approveExpense` / `postExpense` / `rejectExpense`: ONE
 * conditional UPDATE in one section, so two concurrent clicks cannot both move it. `approve` takes draft/pending to approved (or to
 * pending when the Worker says the two-step rule applies: it read `expenseTwoStepApproval` and compared the approver with the
 * creator, which this op does not repeat), `post` takes approved to posted, `reject` takes draft/pending to rejected. A row in
 * another status, or no such row, changes nothing and says which, so the Worker raises the same error the Postgres twin does.
 * Posting does NOT book the journal: the Worker sends `accounting/expense-posted` after this returns (the journal job is idempotent).
 */
export function expenseTransitionOp(
  db: SyncSql,
  storeId: string,
  a: Record<string, unknown>
): { found: boolean; changed: boolean; status: string | null } {
  if (typeof a.expenseId !== 'string' || a.expenseId.length === 0 || a.expenseId.length > 128)
    throw new MoneyError('BAD_ARGS', 'expenseId', 400);
  const now = Date.now();
  const userId = typeof a.userId === 'string' && a.userId.length <= 128 ? a.userId : null;
  let sql: string;
  let params: unknown[];
  switch (a.action) {
    case 'approve': {
      const pending = a.pending === true;
      sql = pending
        ? "UPDATE expenses SET status = 'pending', approved_by = NULL, approved_at = NULL, updated_at = ?1 WHERE id = ?2 AND store_id = ?3 AND status IN ('draft', 'pending')"
        : "UPDATE expenses SET status = 'approved', approved_by = ?4, approved_at = ?1, updated_at = ?1 WHERE id = ?2 AND store_id = ?3 AND status IN ('draft', 'pending')";
      params = pending ? [now, a.expenseId, storeId] : [now, a.expenseId, storeId, userId];
      break;
    }
    case 'post':
      sql =
        "UPDATE expenses SET status = 'posted', posted_at = ?1, updated_at = ?1 WHERE id = ?2 AND store_id = ?3 AND status = 'approved'";
      params = [now, a.expenseId, storeId];
      break;
    case 'reject':
      sql =
        "UPDATE expenses SET status = 'rejected', updated_at = ?1 WHERE id = ?2 AND store_id = ?3 AND status IN ('draft', 'pending')";
      params = [now, a.expenseId, storeId];
      break;
    default:
      throw new MoneyError('BAD_ARGS', 'action', 400);
  }
  const changed = db.run(sql, params).changes > 0;
  const row = db.all('SELECT status FROM expenses WHERE id = ? AND store_id = ?', [
    a.expenseId,
    storeId,
  ])[0];
  return { found: Boolean(row), changed, status: row ? String(row.status) : null };
}

const IDENT = /^[a-z][a-z0-9_]{0,63}$/;

/**
 * One page of the values that may hold an R2 URL (`r2-orphan-sweep`): `columns` of `table`, keyset-paged on `id`. The table and
 * column names come from the Worker's reference registry, so they are never trusted as SQL: each must be a plain identifier AND
 * exist in this store's schema (`pragma_table_info`). A table or column the schema does not have answers `missing`, so the caller
 * can refuse to delete anything rather than call a live object an orphan. Values come back as stored text (JSON stays text; the
 * Worker parses it with the same extractor the Postgres read uses). Store-scoped by the DO, read-only.
 */
export function r2ReferencesOp(
  db: SyncSql,
  storeId: string,
  a: Record<string, unknown>
): { missing: boolean; rows: Array<Record<string, string | null>>; last: string | null } {
  const table = a.table;
  const columns = a.columns;
  if (typeof table !== 'string' || !IDENT.test(table))
    throw new MoneyError('BAD_ARGS', 'table', 400);
  if (
    !Array.isArray(columns) ||
    columns.length === 0 ||
    columns.length > 16 ||
    columns.some(c => typeof c !== 'string' || !IDENT.test(c))
  )
    throw new MoneyError('BAD_ARGS', 'columns', 400);
  const after = typeof a.after === 'string' ? a.after : '';
  const limit = intArg(a.limit, 'limit', 1, 2000);
  const have = new Set(
    db.all(`SELECT name FROM pragma_table_info('${table}')`, []).map(r => String(r.name))
  );
  if (!have.has('id') || (columns as string[]).some(c => !have.has(c)))
    return { missing: true, rows: [], last: null };
  const scoped = have.has('store_id');
  const select = (columns as string[]).map(c => `CAST("${c}" AS TEXT) AS "${c}"`).join(', ');
  const rows = db.all(
    `SELECT "id" AS id, ${select} FROM "${table}" WHERE "id" > ?1 ${scoped ? 'AND "store_id" = ?3' : ''} ORDER BY "id" ASC LIMIT ?2`,
    scoped ? [after, limit, storeId] : [after, limit]
  ) as Array<Record<string, string | null>>;
  return {
    missing: false,
    rows,
    last: rows.length === limit ? String(rows[rows.length - 1].id) : null,
  };
}

/**
 * Create a merchant webhook endpoint under the per-store cap in ONE section: the count and the insert are the same synchronous
 * run, so N concurrent creates (a Durable Object interleaves requests at every `await` between calls, never inside one) can never
 * pass the cap together. The Worker validates the URL BEFORE this call and sends the secret already encrypted.
 */
export function webhookEndpointCreateOp(
  db: SyncSql,
  storeId: string,
  a: Record<string, unknown>
): { id: string } {
  const max = intArg(a.maxEndpoints, 'maxEndpoints', 1, 1000);
  const str = (v: unknown, what: string, maxLen: number, nullable = false): string | null => {
    if (v == null && nullable) return null;
    if (typeof v !== 'string' || v.length === 0 || v.length > maxLen)
      throw new MoneyError('BAD_ARGS', what, 400);
    return v;
  };
  const events = a.events;
  if (
    !Array.isArray(events) ||
    events.length === 0 ||
    events.length > 64 ||
    events.some(e => typeof e !== 'string')
  )
    throw new MoneyError('BAD_ARGS', 'events', 400);
  const n = Number(
    db.all('SELECT COUNT(*) AS n FROM webhook_endpoints WHERE store_id = ?', [storeId])[0].n
  );
  if (n >= max)
    throw new MoneyError('WEBHOOK_LIMIT', 'Webhook endpoint limit reached', 409, { limit: max });
  const id = crypto.randomUUID();
  const now = Date.now();
  db.run(
    `INSERT INTO webhook_endpoints (id, store_id, url, description, events, include_customer, secret_enc, secret_hint, created_by, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?10)`,
    [
      id,
      storeId,
      str(a.url, 'url', 2048),
      str(a.description, 'description', 120, true),
      JSON.stringify(events),
      a.includeCustomer === true ? 1 : 0,
      str(a.secretEnc, 'secretEnc', 4000),
      str(a.secretHint, 'secretHint', 8),
      str(a.createdBy, 'createdBy', 128, true),
      now,
    ]
  );
  return { id };
}

/**
 * The next batch of product vectors to build, trimmed to what today's embedding budget still allows (the same greedy fit
 * `syncProductVectors` applies), and the vectors of products that are no longer indexable. Read-only.
 */
export function vectorPlanOp(
  db: SyncSql,
  storeId: string,
  a: Record<string, unknown>
): { work: VectorWork[]; orphans: string[]; capped: boolean } {
  const limit = intArg(a.limit, 'limit', 1, 100);
  const cap =
    a.dailyCap === undefined ? DEFAULT_DAILY_CAP : intArg(a.dailyCap, 'dailyCap', 0, 1_000_000);
  const now = Date.now();
  const plan = planVectorWork(db, storeId, limit, now);
  let room = cap - embedUsageToday(db, storeId, now);
  const work: VectorWork[] = [];
  let capped = false;
  for (const w of plan.work) {
    const n = (w.needDoc && w.doc ? 1 : 0) + (w.needWords && w.words ? 1 : 0);
    if (n > room) {
      capped = true;
      break;
    }
    room -= n;
    work.push(w);
  }
  return { work, orphans: plan.orphans, capped };
}

/**
 * Settle one batch after the Worker embedded it and upserted the vectors: count the texts sent against today's budget, forget
 * the orphans' state, quarantine the texts the model rejected, and commit each built product against its CURRENT row (an edit
 * in between leaves it stale, a product that stopped being indexable has its fresh vectors returned in `cleanup`).
 */
export function vectorCommitOp(
  db: SyncSql,
  storeId: string,
  a: Record<string, unknown>
): { embedded: number; cleanup: string[]; quarantined: number } {
  const ready = a.ready as VectorWork[] | undefined;
  const failures = a.failures as Array<{ work: VectorWork; kind: string }> | undefined;
  const forget = a.forget as string[] | undefined;
  if (!Array.isArray(ready) || !Array.isArray(failures) || !Array.isArray(forget))
    throw new MoneyError('BAD_ARGS', 'ready/failures/forget', 400);
  if (ready.length + failures.length + forget.length > 200)
    throw new MoneyError('BAD_ARGS', 'batch', 400);
  const texts = intArg(a.texts, 'texts', 0, 100_000);
  const now = Date.now();
  if (texts > 0) {
    try {
      reserveEmbedTexts(db, storeId, texts, Number.MAX_SAFE_INTEGER, now);
    } catch {
      /* spend is counted after the fact; the plan already fitted the batch to the budget */
    }
  }
  db.transactionSync(() => {
    for (const id of forget)
      db.run('DELETE FROM product_vector_state WHERE product_id = ? AND store_id = ?', [
        id,
        storeId,
      ]);
    for (const f of failures) quarantineVectorFailure(db, storeId, f.work, f.kind, now);
  });
  const done = commitVectorWork(db, storeId, ready, now);
  return { embedded: done.embedded, cleanup: done.cleanup, quarantined: failures.length };
}

/** True while any indexable product still needs a vector (the backstop probe). */
/** The storefront-visible subset of the product ids a Vectorize query returned (a read; Ruling CF-VEC-1). */
export function vectorVisibleOp(
  db: SyncSql,
  storeId: string,
  a: Record<string, unknown>
): { ids: string[] } {
  if (!Array.isArray(a.ids) || a.ids.some(x => typeof x !== 'string' || x.length > 128))
    throw new MoneyError('BAD_ARGS', 'ids', 400);
  return { ids: visibleVectorProductIds(db, storeId, a.ids as string[]) };
}

export function vectorStatusOp(db: SyncSql, storeId: string) {
  return vectorStatus(db, storeId);
}

export function vectorStaleOp(db: SyncSql, storeId: string): { stale: boolean } {
  return { stale: hasStaleVectors(db, storeId) };
}

/**
 * The merchant marks cash-on-delivery orders as paid (NEON-ZERO-1 group A, Ruling NZ-A-2): the twin of the single and the
 * bulk `mark-paid` route writes, ONE section for the whole batch like the Postgres `$transaction`. Per order: the COD payment
 * becomes `completed` (paid now), the order `paymentStatus` becomes `paid`, and only a still-`pending` order advances to
 * `confirmed` (a further-along order keeps its fulfilment status). An order that is already paid, cancelled or refunded, or has
 * no COD payment, is SKIPPED (the answer lists what was actually updated), so a double click or a race books nothing twice.
 */
export function codMarkPaidOp(
  db: SyncSql,
  storeId: string,
  a: Record<string, unknown>
): {
  updated: Array<{
    orderId: string;
    paymentId: string;
    fromStatus: string;
    orderNumber: string;
  }>;
} {
  const ids = a.orderIds;
  if (
    !Array.isArray(ids) ||
    ids.length === 0 ||
    ids.length > 50 ||
    ids.some(x => typeof x !== 'string' || x.length === 0 || x.length > 128)
  )
    throw new MoneyError('BAD_ARGS', 'orderIds', 400);
  const now = Date.now();
  return db.transactionSync(() => {
    const updated: Array<{
      orderId: string;
      paymentId: string;
      fromStatus: string;
      orderNumber: string;
    }> = [];
    for (const orderId of ids as string[]) {
      const o = db.all(
        'SELECT id, status, payment_status, order_number FROM orders WHERE id = ? AND store_id = ?',
        [orderId, storeId]
      )[0];
      if (!o || o.payment_status === 'paid' || o.status === 'cancelled' || o.status === 'refunded')
        continue;
      const p = db.all(
        "SELECT id, status FROM payments WHERE order_id = ? AND provider = 'cod' ORDER BY created_at, id LIMIT 1",
        [orderId]
      )[0];
      if (!p) continue;
      db.run(
        "UPDATE payments SET status = 'completed', paid_at = ?1, updated_at = ?1 WHERE id = ?2",
        [now, p.id]
      );
      db.run(
        "UPDATE orders SET payment_status = 'paid', status = CASE WHEN status = 'pending' THEN 'confirmed' ELSE status END, updated_at = ?1 WHERE id = ?2 AND store_id = ?3",
        [now, orderId, storeId]
      );
      updated.push({
        orderId,
        paymentId: p.id as string,
        fromStatus: p.status as string,
        orderNumber: o.order_number as string,
      });
    }
    return { updated };
  });
}
