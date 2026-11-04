/**
 * NEON-ZERO-1 (N-10b): the raw-SQL corners of the `platform` and `inbox` families (see cutover.ts). Same contract as
 * billing-d1.ts: each helper replaces a Postgres definer or row lock, and its caller uses it only when the family's
 * cutover marker exists. The definers' own "caller is a super_admin / the webhook job" checks were Postgres session
 * state (GUCs); on D1 the route's `authorize` and the job entry point are the gate (Ruling NZ-10-4).
 */
import { d1All, d1Run, fromMs } from './billing-d1';

// ───────────────────────────── webhook inbox (family `inbox`) ──────────────────────────

export interface InboxRowD1 {
  id: string;
  provider: string;
  idempotency_key: string;
  store_id: string | null;
  payload: unknown;
  raw_body: string;
  signature: string;
  status: string;
  attempts: number;
  last_error: string | null;
  result_order_id: string | null;
  result_status: string | null;
  received_at: Date;
}

const parseJson = (v: unknown): unknown => {
  if (typeof v !== 'string') return v;
  try {
    return JSON.parse(v);
  } catch {
    return v;
  }
};

type RawInbox = Omit<InboxRowD1, 'received_at' | 'payload'> & {
  received_at: number;
  payload: string;
};
const toRow = (r: RawInbox): InboxRowD1 => ({
  ...r,
  payload: parseJson(r.payload),
  received_at: fromMs(r.received_at)!,
});

/** `ebda_webhook_inbox_record`: first delivery inserts; a redelivery refreshes a row that is NOT yet processed. */
export async function inboxRecordD1(input: {
  id: string;
  provider: string;
  idempotencyKey: string;
  storeId: string | null;
  payload: object;
  rawBody: string;
  signature: string;
}): Promise<string> {
  const now = Date.now();
  const rows = await d1All<{ id: string }>(
    `INSERT INTO webhook_events (id, provider, idempotency_key, store_id, payload, raw_body, signature, status, received_at, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'received', ?8, ?8, ?8)
     ON CONFLICT (idempotency_key) DO UPDATE
       SET payload = excluded.payload, raw_body = excluded.raw_body, signature = excluded.signature,
           store_id = excluded.store_id, updated_at = excluded.updated_at
       WHERE webhook_events.status <> 'processed'
     RETURNING id`,
    input.id,
    input.provider,
    input.idempotencyKey,
    input.storeId,
    JSON.stringify(input.payload),
    input.rawBody,
    input.signature,
    now
  );
  if (rows[0]) return rows[0].id;
  const existing = await d1All<{ id: string }>(
    'SELECT id FROM webhook_events WHERE idempotency_key = ?1',
    input.idempotencyKey
  );
  return existing[0].id;
}

export async function inboxGetD1(id: string): Promise<InboxRowD1 | null> {
  const rows = await d1All<RawInbox>('SELECT * FROM webhook_events WHERE id = ?1', id);
  return rows[0] ? toRow(rows[0]) : null;
}

/** `ebda_webhook_inbox_update`: only these columns can change. */
export async function inboxUpdateD1(
  id: string,
  p: {
    status?: string;
    lastError?: string;
    incrementAttempts?: boolean;
    markProcessed?: { resultOrderId?: string | null; resultStatus?: string | null };
    requeue?: boolean;
  }
): Promise<boolean> {
  const now = Date.now();
  const changes = await d1Run(
    `UPDATE webhook_events SET
       status = CASE WHEN ?8 THEN 'received' ELSE COALESCE(?2, status) END,
       attempts = CASE WHEN ?8 THEN 0 ELSE attempts + CASE WHEN ?4 THEN 1 ELSE 0 END END,
       last_error = CASE WHEN ?8 OR ?5 THEN NULL WHEN ?3 IS NOT NULL THEN ?3 ELSE last_error END,
       received_at = CASE WHEN ?8 THEN ?9 ELSE received_at END,
       processed_at = CASE WHEN ?5 THEN ?9 ELSE processed_at END,
       result_order_id = CASE WHEN ?5 THEN ?6 ELSE result_order_id END,
       result_status = CASE WHEN ?5 THEN ?7 ELSE result_status END,
       updated_at = ?9
     WHERE id = ?1`,
    id,
    p.status ?? null,
    p.lastError ?? null,
    p.incrementAttempts === true ? 1 : 0,
    p.markProcessed !== undefined ? 1 : 0,
    p.markProcessed?.resultOrderId ?? null,
    p.markProcessed?.resultStatus ?? null,
    p.requeue === true ? 1 : 0,
    now
  );
  return changes > 0;
}

/** `ebda_webhook_inbox_stuck`: never consumed or wedged rows, oldest first. */
export async function inboxStuckD1(cutoff: Date, limit: number) {
  return d1All<{
    id: string;
    provider: string;
    idempotency_key: string;
    store_id: string | null;
    status: string;
    attempts: number;
    received_at: number;
  }>(
    `SELECT id, provider, idempotency_key, store_id, status, attempts, received_at FROM webhook_events
      WHERE status IN ('received', 'processing') AND received_at < ?1
      ORDER BY received_at ASC LIMIT ?2`,
    cutoff.getTime(),
    Math.max(limit, 0)
  ).then(rows => rows.map(r => ({ ...r, received_at: fromMs(r.received_at)! })));
}

/** `ebda_platform_webhook_inbox_list` (the audit row is written by the caller). */
export async function inboxListD1(f: {
  status?: string;
  provider?: string;
  limit: number;
  offset: number;
}) {
  const rows = await d1All<
    Omit<RawInbox, 'payload' | 'raw_body' | 'signature'> & { total: number }
  >(
    `SELECT id, provider, store_id, status, attempts, last_error, result_order_id, result_status,
            idempotency_key, received_at, count(*) OVER () AS total
       FROM webhook_events
      WHERE (?1 IS NULL OR status = ?1) AND (?2 IS NULL OR provider = ?2)
      ORDER BY received_at DESC LIMIT ?3 OFFSET ?4`,
    f.status ?? null,
    f.provider ?? null,
    Math.max(f.limit, 0),
    Math.max(f.offset, 0)
  );
  return rows.map(r => ({ ...r, received_at: fromMs(r.received_at)! }));
}

// ───────────────────────────── legal notices (family `platform`) ───────────────────────

/**
 * `ebda_withdraw_legal_notice_send`: delete the send row ONLY while nobody has started the fan-out (no recipient count, no
 * delivery for its doc + version, sent by `operatorId` within 10 minutes). One statement, so the check and the delete cannot
 * be separated (Postgres used a row lock for the same guarantee). Returns rows deleted.
 */
export async function withdrawLegalSendD1(
  sendId: string,
  operatorId: string,
  now: Date
): Promise<number> {
  return d1Run(
    `DELETE FROM legal_notice_sends
      WHERE id = ?1 AND sent_by = ?2 AND recipient_count IS NULL AND sent_at >= ?3
        AND NOT EXISTS (SELECT 1 FROM legal_notice_deliveries d
                         WHERE d.doc_key = legal_notice_sends.doc_key AND d.version = legal_notice_sends.version)`,
    sendId,
    operatorId,
    now.getTime() - 10 * 60_000
  );
}

/** `SELECT ... FROM legal_notice_sends WHERE id = $1 FOR UPDATE` -> the row, without a lock (see sendRowStillExistsD1). */
export async function legalSendRowD1(sendId: string) {
  const rows = await d1All<{
    id: string;
    doc_key: string;
    version: string;
    recipient_count: number | null;
  }>('SELECT id, doc_key, version, recipient_count FROM legal_notice_sends WHERE id = ?1', sendId);
  return rows[0] ?? null;
}

export async function sendRowStillExistsD1(sendId: string): Promise<boolean> {
  return (await d1All('SELECT 1 AS ok FROM legal_notice_sends WHERE id = ?1', sendId)).length > 0;
}

// ───────────────────────────── merchant keys ───────────────────────────────────────────

/** The merchant-key half of `ebda_user_revoke_sessions`: revoke every live key of the user in every store. */
export async function revokeUserMerchantKeysD1(userId: string, now: Date): Promise<number> {
  return d1Run(
    'UPDATE merchant_api_keys SET revoked_at = ?2, updated_at = ?2 WHERE user_id = ?1 AND revoked_at IS NULL',
    userId,
    now.getTime()
  );
}
