import { AWAITING_PAYMENT_CONFIRMATION } from '../../../shared/src/payments';
import { addPaymentEvent } from './payments';
import { MoneyError, type SyncSql } from './sync-sql';

/**
 * InstaPay ORDER receipts on the StoreDO (INFRA-CF-1 R3, Ruling INSTAPAY-DO-1). Port of the order half of
 * `payment-providers/instapay-receipt.service.ts` and the receipt steps of `instapay.service.ts` (`submitReceipt`,
 * `rejectReceipt`, `approveSubmitted`, the retention sweep, the erasure scrub).
 *
 * Subscription receipts are platform-owned and stay where they are; an ORDER receipt of a DO store lives here, in the same
 * database as the order and its payment, so the submit (receipt + hold freeze + payment metadata + payment event) is ONE
 * `transactionSync` section where Postgres needed `lockOrder` (FOR UPDATE) and a savepoint.
 *
 * The AI read, the flag computation and the object storage stay in the Worker. The flags depend on the row (its AI read), so
 * the Worker reads the row, computes them, and passes `extractionStatus` as it saw it: if the row changed in between the
 * submit is refused `RECEIPT_CHANGED` (409) and the Worker recomputes once.
 *
 * Reference uniqueness: the partial unique index below is the same-store guarantee (atomic, replaces the Postgres UNIQUE
 * `reference_key`). The cross-store half is a synchronous claim in D1 `entity_index` (kind `instapay_ref`) made by the Worker.
 */
export const MAX_RECEIPTS_PER_ORDER = 6;

export const INSTAPAY_RECEIPT_DDL: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS instapay_order_receipts (
     id TEXT PRIMARY KEY, store_id TEXT NOT NULL, order_id TEXT NOT NULL, payment_id TEXT,
     storage_key TEXT NOT NULL, mime_type TEXT NOT NULL, size_bytes INTEGER NOT NULL, sha256 TEXT NOT NULL,
     status TEXT NOT NULL DEFAULT 'draft', extraction_status TEXT NOT NULL DEFAULT 'pending', extraction_error TEXT,
     extracted TEXT, confidence REAL, amount_minor INTEGER, reference TEXT, reference_key TEXT, transferred_at INTEGER,
     payer_name TEXT, payer_address TEXT, payer_mobile TEXT, payer_bank TEXT,
     receiver_name TEXT, receiver_handle TEXT, receiver_mobile TEXT, note TEXT,
     expected_amount_minor INTEGER, expected_receiver TEXT, flags TEXT NOT NULL DEFAULT '[]',
     review_note TEXT, reviewed_by TEXT, reviewed_at INTEGER, submitted_at INTEGER,
     image_deleted_at INTEGER, personal_scrubbed_at INTEGER, created_at INTEGER NOT NULL)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS instapay_order_receipts_reference_key ON instapay_order_receipts (reference_key) WHERE reference_key IS NOT NULL`,
  `CREATE INDEX IF NOT EXISTS instapay_order_receipts_order ON instapay_order_receipts (store_id, order_id, status)`,
];

export function ensureReceiptSchema(db: SyncSql): void {
  for (const s of INSTAPAY_RECEIPT_DDL) db.run(s, []);
}

const err = (code: string, message: string, status = 409) => new MoneyError(code, message, status);
const need = (v: unknown, name: string): string => {
  if (typeof v !== 'string' || v.length < 1 || v.length > 400)
    throw err('BAD_ID', `${name} is required`, 400);
  return v;
};
const parse = (v: unknown): Record<string, unknown> => {
  try {
    const o = typeof v === 'string' ? JSON.parse(v) : v;
    return o && typeof o === 'object' ? (o as Record<string, unknown>) : {};
  } catch {
    return {};
  }
};

export interface ReceiptRow {
  id: string;
  storeId: string;
  orderId: string;
  paymentId: string | null;
  storageKey: string;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
  status: string;
  extractionStatus: string;
  extractionError: string | null;
  extracted: unknown;
  confidence: number | null;
  amountMinor: number | null;
  reference: string | null;
  referenceKey: string | null;
  transferredAt: number | null;
  payerName: string | null;
  payerAddress: string | null;
  payerMobile: string | null;
  payerBank: string | null;
  receiverName: string | null;
  receiverHandle: string | null;
  receiverMobile: string | null;
  note: string | null;
  expectedAmountMinor: number | null;
  expectedReceiver: string | null;
  flags: string[];
  reviewNote: string | null;
  reviewedBy: string | null;
  reviewedAt: number | null;
  submittedAt: number | null;
  imageDeletedAt: number | null;
  personalScrubbedAt: number | null;
  createdAt: number;
}
const s = (v: unknown): string | null => (v === null || v === undefined ? null : (v as string));
const n = (v: unknown): number | null => (v === null || v === undefined ? null : (v as number));
function rowOf(r: Record<string, unknown>): ReceiptRow {
  return {
    id: r.id as string,
    storeId: r.store_id as string,
    orderId: r.order_id as string,
    paymentId: s(r.payment_id),
    storageKey: r.storage_key as string,
    mimeType: r.mime_type as string,
    sizeBytes: r.size_bytes as number,
    sha256: r.sha256 as string,
    status: r.status as string,
    extractionStatus: r.extraction_status as string,
    extractionError: s(r.extraction_error),
    extracted: r.extracted ? JSON.parse(r.extracted as string) : null,
    confidence: n(r.confidence),
    amountMinor: n(r.amount_minor),
    reference: s(r.reference),
    referenceKey: s(r.reference_key),
    transferredAt: n(r.transferred_at),
    payerName: s(r.payer_name),
    payerAddress: s(r.payer_address),
    payerMobile: s(r.payer_mobile),
    payerBank: s(r.payer_bank),
    receiverName: s(r.receiver_name),
    receiverHandle: s(r.receiver_handle),
    receiverMobile: s(r.receiver_mobile),
    note: s(r.note),
    expectedAmountMinor: n(r.expected_amount_minor),
    expectedReceiver: s(r.expected_receiver),
    flags: JSON.parse((r.flags as string) || '[]'),
    reviewNote: s(r.review_note),
    reviewedBy: s(r.reviewed_by),
    reviewedAt: n(r.reviewed_at),
    submittedAt: n(r.submitted_at),
    imageDeletedAt: n(r.image_deleted_at),
    personalScrubbedAt: n(r.personal_scrubbed_at),
    createdAt: r.created_at as number,
  };
}
const COLS = '*';

function loadOrder(db: SyncSql, storeId: string, orderId: string) {
  const o = db.all(
    'SELECT id, status, created_at, payment_confirmation_expires_at FROM orders WHERE id = ? AND store_id = ? AND deleted_at IS NULL',
    [orderId, storeId]
  )[0];
  if (!o) throw err('ORDER_NOT_FOUND', 'order not found', 404);
  return o;
}
function awaiting(db: SyncSql, storeId: string, orderId: string) {
  const o = loadOrder(db, storeId, orderId);
  if (o.status !== AWAITING_PAYMENT_CONFIRMATION)
    throw err('INSTAPAY_NOT_AWAITING', 'This order is not waiting for a transfer');
  return o;
}

/** The draft row for an uploaded screenshot (the object is already in the private bucket). Capped per order. */
export function createReceipt(
  db: SyncSql,
  a: {
    storeId: string;
    orderId: string;
    paymentId?: string | null;
    storageKey: string;
    mimeType: string;
    sizeBytes: number;
    sha256: string;
    now?: number;
  }
): ReceiptRow {
  const now = a.now ?? Date.now();
  return db.transactionSync(() => {
    awaiting(db, a.storeId, need(a.orderId, 'orderId'));
    const count = db.all(
      'SELECT COUNT(*) AS c FROM instapay_order_receipts WHERE store_id = ? AND order_id = ?',
      [a.storeId, a.orderId]
    )[0].c as number;
    if (count >= MAX_RECEIPTS_PER_ORDER)
      throw err('TOO_MANY_RECEIPTS', 'Too many receipts were uploaded. Contact support.', 429);
    const id = crypto.randomUUID();
    db.run(
      `INSERT INTO instapay_order_receipts (id, store_id, order_id, payment_id, storage_key, mime_type, size_bytes, sha256, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        a.storeId,
        a.orderId,
        a.paymentId ?? null,
        need(a.storageKey, 'storageKey'),
        need(a.mimeType, 'mimeType'),
        a.sizeBytes,
        need(a.sha256, 'sha256'),
        now,
      ]
    );
    return rowOf(db.all('SELECT * FROM instapay_order_receipts WHERE id = ?', [id])[0]);
  });
}

/** The AI read result: only a `pending` read is written, so a retried job changes nothing. */
export function recordExtraction(
  db: SyncSql,
  a: {
    storeId: string;
    receiptId: string;
    status: 'done' | 'failed';
    extracted?: unknown;
    confidence?: number | null;
    error?: string | null;
  }
): { updated: boolean } {
  const r = db.run(
    `UPDATE instapay_order_receipts SET extraction_status = ?, extracted = ?, confidence = ?, extraction_error = ?
      WHERE id = ? AND store_id = ? AND extraction_status = 'pending'`,
    [
      a.status,
      a.status === 'done' ? JSON.stringify(a.extracted ?? null) : null,
      a.status === 'done' ? (a.confidence ?? null) : null,
      a.status === 'failed' ? String(a.error ?? 'ai_failed').slice(0, 200) : null,
      a.receiptId,
      a.storeId,
    ]
  );
  return { updated: r.changes > 0 };
}

export function getReceipt(
  db: SyncSql,
  a: { storeId: string; receiptId: string; orderId?: string }
): ReceiptRow {
  const r = db.all(
    `SELECT * FROM instapay_order_receipts WHERE id = ? AND store_id = ?${a.orderId ? ' AND order_id = ?' : ''}`,
    a.orderId ? [a.receiptId, a.storeId, a.orderId] : [a.receiptId, a.storeId]
  )[0];
  if (!r) throw err('RECEIPT_NOT_FOUND', 'Receipt not found', 404);
  return rowOf(r);
}

export function listReceipts(db: SyncSql, a: { storeId: string; orderId: string }): ReceiptRow[] {
  return db
    .all(
      `SELECT * FROM instapay_order_receipts WHERE store_id = ? AND order_id = ? AND status != 'draft' ORDER BY created_at DESC, id DESC LIMIT 20`,
      [a.storeId, a.orderId]
    )
    .map(rowOf);
}

/** How many receipts of the order wait for the merchant, and how many already carry the same screenshot (any order of the store). */
export function proofState(
  db: SyncSql,
  a: { storeId: string; orderId: string; sha256?: string; exceptId?: string }
): { submitted: number; sameImage: number } {
  return {
    submitted: db.all(
      "SELECT COUNT(*) AS c FROM instapay_order_receipts WHERE store_id = ? AND order_id = ? AND status = 'submitted'",
      [a.storeId, a.orderId]
    )[0].c as number,
    sameImage: a.sha256
      ? (db.all(
          'SELECT COUNT(*) AS c FROM instapay_order_receipts WHERE store_id = ? AND sha256 = ? AND id != ?',
          [a.storeId, a.sha256, a.exceptId ?? '']
        )[0].c as number)
      : 0,
  };
}

export interface SubmitFields {
  amountMinor: number;
  reference: string;
  transferredAt: number;
  payerName: string | null;
  payerAddress: string | null;
  payerMobile: string | null;
  payerBank: string | null;
  receiverName: string | null;
  receiverHandle: string | null;
  receiverMobile: string | null;
  note: string | null;
}

/**
 * The payer submits the corrected fields: the receipt becomes `submitted`, claims its reference, the order's hold is frozen
 * (audit O1), the payment remembers the reference and a payment event is written. ONE section; any refusal rolls all of it back.
 */
export function submitReceipt(
  db: SyncSql,
  a: {
    storeId: string;
    orderId: string;
    receiptId: string;
    fields: SubmitFields;
    referenceKey: string;
    flags: string[];
    extractionStatus: string;
    expectedAmountMinor: number | null;
    expectedReceiver: string | null;
    now?: number;
  }
): ReceiptRow {
  const now = a.now ?? Date.now();
  return db.transactionSync(() => {
    awaiting(db, a.storeId, a.orderId);
    // same order of refusals as the Postgres service: a receipt already waiting for the store first, then the row itself
    const live = db.all(
      "SELECT COUNT(*) AS c FROM instapay_order_receipts WHERE store_id = ? AND order_id = ? AND status = 'submitted'",
      [a.storeId, a.orderId]
    )[0].c as number;
    if (live > 0)
      throw err('PROOF_PENDING_REVIEW', 'Your receipt is already waiting for the store');
    const row = getReceipt(db, { storeId: a.storeId, receiptId: a.receiptId, orderId: a.orderId });
    if (row.status !== 'draft')
      throw err('RECEIPT_NOT_DRAFT', 'This receipt was already submitted');
    if (row.extractionStatus !== a.extractionStatus)
      throw err('RECEIPT_CHANGED', 'The receipt changed while submitting; try again');
    const pay = db.all(
      "SELECT id, metadata FROM payments WHERE order_id = ? AND provider = 'instapay' AND status = 'pending' ORDER BY created_at DESC LIMIT 1",
      [a.orderId]
    )[0];
    if (!pay) throw err('NOT_FOUND', 'No InstaPay payment for this order', 404);
    const taken = db.all(
      'SELECT id FROM instapay_order_receipts WHERE reference_key = ? AND id != ?',
      [a.referenceKey, row.id]
    )[0];
    if (taken)
      throw err(
        'DUPLICATE_REFERENCE',
        'This transfer reference was already used. Each transfer can pay only once.'
      );
    const f = a.fields;
    db.run(
      `UPDATE instapay_order_receipts SET status = 'submitted', submitted_at = ?, amount_minor = ?, reference = ?, reference_key = ?,
         transferred_at = ?, payer_name = ?, payer_address = ?, payer_mobile = ?, payer_bank = ?, receiver_name = ?, receiver_handle = ?,
         receiver_mobile = ?, note = ?, expected_amount_minor = ?, expected_receiver = ?, flags = ?
       WHERE id = ? AND store_id = ?`,
      [
        now,
        f.amountMinor,
        f.reference.trim(),
        a.referenceKey,
        f.transferredAt,
        f.payerName,
        f.payerAddress,
        f.payerMobile,
        f.payerBank,
        f.receiverName,
        f.receiverHandle,
        f.receiverMobile,
        f.note,
        a.expectedAmountMinor,
        a.expectedReceiver,
        JSON.stringify(a.flags),
        row.id,
        a.storeId,
      ]
    );
    // freeze the hold: a shopper who sent proof keeps the order confirmable (audit O1)
    db.run(
      'UPDATE orders SET payment_confirmation_expires_at = NULL, updated_at = ? WHERE id = ? AND store_id = ? AND status = ?',
      [now, a.orderId, a.storeId, AWAITING_PAYMENT_CONFIRMATION]
    );
    db.run('UPDATE payments SET metadata = ?, updated_at = ? WHERE id = ?', [
      JSON.stringify({
        ...parse(pay.metadata),
        customerReference: f.reference.trim(),
        customerReferenceAt: new Date(now).toISOString(),
        receiptId: row.id,
      }),
      now,
      pay.id,
    ]);
    addPaymentEvent(db, {
      storeId: a.storeId,
      paymentId: pay.id as string,
      orderId: a.orderId,
      eventType: 'status_change',
      from: 'pending',
      to: 'pending',
      provider: 'instapay',
      details: { reason: 'customer_receipt_submitted', receiptId: row.id, flags: a.flags },
      now,
    });
    return getReceipt(db, { storeId: a.storeId, receiptId: row.id });
  });
}

/**
 * The merchant rejects a submitted receipt with a reason: the reference is freed, the hold restarts at
 * max(original deadline, now + 24 h), the payment forgets the reference, a payment event is written.
 */
export function rejectReceipt(
  db: SyncSql,
  a: {
    storeId: string;
    orderId: string;
    receiptId: string;
    note: string;
    actorId: string | null;
    now?: number;
  }
): { receiptId: string; expiresAt: number; referenceKey: string | null } {
  const now = a.now ?? Date.now();
  const note = a.note.trim();
  if (note.length < 3) throw err('REASON_REQUIRED', 'Write why the receipt is rejected', 400);
  return db.transactionSync(() => {
    awaiting(db, a.storeId, a.orderId);
    const row = getReceipt(db, { storeId: a.storeId, receiptId: a.receiptId, orderId: a.orderId });
    const done = db.run(
      `UPDATE instapay_order_receipts SET status = 'rejected', reference_key = NULL, review_note = ?, reviewed_by = ?, reviewed_at = ?
        WHERE id = ? AND store_id = ? AND status = 'submitted'`,
      [note.slice(0, 500), a.actorId, now, row.id, a.storeId]
    );
    if (done.changes < 1)
      throw err('RECEIPT_NOT_PENDING', 'This receipt is not waiting for review');
    const pay = db.all(
      "SELECT id, metadata FROM payments WHERE order_id = ? AND provider = 'instapay' AND status = 'pending' ORDER BY created_at DESC LIMIT 1",
      [a.orderId]
    )[0];
    const m = parse(pay?.metadata);
    const original = typeof m.expiresAt === 'string' ? new Date(m.expiresAt).getTime() : 0;
    const expiresAt = Math.max(original, now + 24 * 3_600_000);
    db.run(
      'UPDATE orders SET payment_confirmation_expires_at = ?, updated_at = ? WHERE id = ? AND store_id = ? AND status = ?',
      [expiresAt, now, a.orderId, a.storeId, AWAITING_PAYMENT_CONFIRMATION]
    );
    if (pay) {
      db.run('UPDATE payments SET metadata = ?, updated_at = ? WHERE id = ?', [
        JSON.stringify({
          ...m,
          customerReference: null,
          receiptRejectedAt: new Date(now).toISOString(),
        }),
        now,
        pay.id,
      ]);
      addPaymentEvent(db, {
        storeId: a.storeId,
        paymentId: pay.id as string,
        orderId: a.orderId,
        eventType: 'admin_action',
        from: 'pending',
        to: 'pending',
        provider: 'instapay',
        userId: a.actorId,
        details: { reason: 'merchant_rejected_receipt', receiptId: row.id, note },
        now,
      });
    }
    return { receiptId: row.id, expiresAt, referenceKey: row.referenceKey };
  });
}

/** The merchant's confirm IS the approval of the shopper's submitted receipts (called inside `confirmInstapay`). Returns the ids. */
export function approveSubmittedReceipts(
  db: SyncSql,
  a: { storeId: string; orderId: string; actorId: string | null; now: number }
): string[] {
  ensureReceiptSchema(db);
  const ids = db
    .all(
      "SELECT id FROM instapay_order_receipts WHERE store_id = ? AND order_id = ? AND status = 'submitted'",
      [a.storeId, a.orderId]
    )
    .map(r => r.id as string);
  for (const id of ids)
    db.run(
      "UPDATE instapay_order_receipts SET status = 'approved', reviewed_by = ?, reviewed_at = ? WHERE id = ? AND status = 'submitted'",
      [a.actorId, a.now, id]
    );
  return ids;
}

export function markImageDeleted(
  db: SyncSql,
  a: { storeId: string; receiptId: string; now?: number }
): { storageKey: string | null; alreadyDeleted: boolean } {
  const r = db.all(
    'SELECT storage_key, image_deleted_at FROM instapay_order_receipts WHERE id = ? AND store_id = ?',
    [a.receiptId, a.storeId]
  )[0];
  if (!r) return { storageKey: null, alreadyDeleted: false };
  if (r.image_deleted_at) return { storageKey: r.storage_key as string, alreadyDeleted: true };
  db.run(
    'UPDATE instapay_order_receipts SET image_deleted_at = ? WHERE id = ? AND store_id = ? AND image_deleted_at IS NULL',
    [a.now ?? Date.now(), a.receiptId, a.storeId]
  );
  return { storageKey: r.storage_key as string, alreadyDeleted: false };
}

const PERSONAL_SCRUB = `payer_name = NULL, payer_address = NULL, payer_mobile = NULL, payer_bank = NULL, receiver_name = NULL,
  receiver_handle = NULL, receiver_mobile = NULL, note = NULL, extracted = NULL, personal_scrubbed_at = ?`;

/**
 * Retention (M-025): scrub the personal fields 180 days after a final decision, and list the screenshots that are due to be
 * deleted (approved; rejected / voided after 30 days; drafts after 30 days; undecided after 90 days; scrubbed but kept).
 * The Worker deletes each object and then calls `markImageDeleted`. Idempotent.
 */
export function sweepRetention(
  db: SyncSql,
  a: { storeId: string; now?: number }
): { dueImages: Array<{ id: string; storageKey: string }>; scrubbed: number } {
  const now = a.now ?? Date.now();
  const day = 86_400_000;
  return db.transactionSync(() => {
    const due = db
      .all(
        `SELECT id, storage_key FROM instapay_order_receipts WHERE store_id = ?1 AND image_deleted_at IS NULL AND (
           status = 'approved'
           OR (status IN ('rejected','voided') AND reviewed_at < ?2)
           OR (status = 'draft' AND created_at < ?2)
           OR (status = 'submitted' AND submitted_at < ?3)
           OR personal_scrubbed_at IS NOT NULL) LIMIT 500`,
        [a.storeId, now - 30 * day, now - 90 * day]
      )
      .map(r => ({ id: r.id as string, storageKey: r.storage_key as string }));
    const res = db.run(
      `UPDATE instapay_order_receipts SET ${PERSONAL_SCRUB} WHERE store_id = ? AND personal_scrubbed_at IS NULL AND (
         (status IN ('approved','rejected','voided') AND reviewed_at < ?) OR (status = 'submitted' AND submitted_at < ?))`,
      [now, a.storeId, now - 180 * day, now - 180 * day]
    );
    return { dueImages: due, scrubbed: res.changes };
  });
}

/**
 * The shopper's erasure: the receipts of the given orders lose their personal fields and are marked, so the next retention
 * sweep deletes their screenshots. Called by the StoreDO's customer erasure with the DO's own order ids, in its section.
 */
export function scrubReceiptsForOrders(
  db: SyncSql,
  a: { orderIds: string[]; now?: number }
): number {
  if (a.orderIds.length === 0) return 0;
  const now = a.now ?? Date.now();
  let total = 0;
  for (const orderId of a.orderIds)
    total += db.run(`UPDATE instapay_order_receipts SET ${PERSONAL_SCRUB} WHERE order_id = ?`, [
      now,
      orderId,
    ]).changes;
  return total;
}
