/**
 * The payment-webhook inbox (`webhook_events`) on D1 `ebda-platform` (NEON-ZERO-1 N-12, Ruling NZ-N12-1). Same contract as the
 * Postgres definers `ebda_webhook_inbox_{record,get,update,stuck}` and `ebda_platform_webhook_inbox_list`: first delivery
 * inserts, a redelivery refreshes a row that is not yet `processed`, `update` changes only the processing columns.
 *
 * Used by `lib/definer.ts` whenever the `PLATFORM_DB` binding exists (every deployed Worker); without it (Node / unit tests /
 * local dev) the definers stay. The caller already authorised (the consumer is a system job, the viewer is `requireRole
 * super_admin`), so the SQL carries no actor check. Timestamps are epoch milliseconds in D1.
 * Staleness class: none (no cache; every read is a primary-key / indexed SELECT). An unreadable D1 is a 503, never a fallback.
 */
import { AppError } from '../middleware/error-handler';
import { platformDb } from './platform-directory';

interface InboxD1 {
  prepare(sql: string): {
    bind(...v: unknown[]): {
      first<T = Record<string, unknown>>(): Promise<T | null>;
      all<T = Record<string, unknown>>(): Promise<{ results?: T[] }>;
      run(): Promise<{ meta?: { changes?: number } }>;
    };
  };
}

export type InboxRowRaw = {
  id: string;
  provider: string;
  idempotency_key: string;
  store_id: string | null;
  payload: string;
  raw_body: string;
  signature: string;
  status: string;
  attempts: number;
  last_error: string | null;
  result_order_id: string | null;
  result_status: string | null;
  received_at: number;
};

const unavailable = () =>
  new AppError(503, 'WEBHOOK_INBOX_UNAVAILABLE', 'Webhook inbox is unavailable');

async function guarded<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch {
    throw unavailable();
  }
}

/** The D1 binding, or undefined where Postgres is still the inbox (Node / tests / local dev). */
export function inboxD1(): InboxD1 | undefined {
  return platformDb() as unknown as InboxD1 | undefined;
}

const INSERT = `INSERT INTO webhook_events (id, provider, idempotency_key, store_id, payload, raw_body, signature, status)
  VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'received')
  ON CONFLICT (idempotency_key) DO UPDATE SET payload = excluded.payload, raw_body = excluded.raw_body,
    signature = excluded.signature, store_id = excluded.store_id, updated_at = CAST(unixepoch('subsec') * 1000 AS INTEGER)
  WHERE webhook_events.status <> 'processed'`;

export async function d1InboxRecord(
  db: InboxD1,
  input: {
    id: string;
    provider: string;
    idempotencyKey: string;
    storeId: string | null;
    payloadJson: string;
    rawBody: string;
    signature: string;
  }
): Promise<string> {
  const run = (storeId: string | null) =>
    db
      .prepare(INSERT)
      .bind(
        input.id,
        input.provider,
        input.idempotencyKey,
        storeId,
        input.payloadJson,
        input.rawBody,
        input.signature
      )
      .run();
  try {
    await run(input.storeId);
  } catch (err) {
    // `store_id` is a foreign key to `stores`: a reference to a store the directory does not hold is recorded store-less
    // (the consumer resolves the store itself) rather than losing the provider's only delivery.
    if (input.storeId && /FOREIGN KEY/i.test(String((err as Error)?.message))) {
      await guarded(() => run(null));
    } else throw unavailable();
  }
  const row = await guarded(() =>
    db
      .prepare('SELECT id FROM webhook_events WHERE idempotency_key = ?1')
      .bind(input.idempotencyKey)
      .first<{ id: string }>()
  );
  if (!row) throw unavailable();
  return row.id;
}

export const d1InboxGet = (db: InboxD1, id: string) =>
  guarded(() =>
    db.prepare('SELECT * FROM webhook_events WHERE id = ?1').bind(id).first<InboxRowRaw>()
  );

export async function d1InboxUpdate(
  db: InboxD1,
  id: string,
  p: {
    status?: string;
    lastError?: string;
    incrementAttempts?: boolean;
    markProcessed?: { resultOrderId?: string | null; resultStatus?: string | null };
    requeue?: boolean;
  }
): Promise<boolean> {
  const res = await guarded(() =>
    db
      .prepare(
        `UPDATE webhook_events SET
          status = CASE WHEN ?8 THEN 'received' ELSE COALESCE(?2, status) END,
          attempts = CASE WHEN ?8 THEN 0 ELSE attempts + CASE WHEN ?4 THEN 1 ELSE 0 END END,
          last_error = CASE WHEN ?8 OR ?5 THEN NULL WHEN ?3 IS NOT NULL THEN ?3 ELSE last_error END,
          received_at = CASE WHEN ?8 THEN CAST(unixepoch('subsec') * 1000 AS INTEGER) ELSE received_at END,
          processed_at = CASE WHEN ?5 THEN CAST(unixepoch('subsec') * 1000 AS INTEGER) ELSE processed_at END,
          result_order_id = CASE WHEN ?5 THEN ?6 ELSE result_order_id END,
          result_status = CASE WHEN ?5 THEN ?7 ELSE result_status END,
          updated_at = CAST(unixepoch('subsec') * 1000 AS INTEGER)
        WHERE id = ?1`
      )
      .bind(
        id,
        p.status ?? null,
        p.lastError ?? null,
        p.incrementAttempts === true ? 1 : 0,
        p.markProcessed !== undefined ? 1 : 0,
        p.markProcessed?.resultOrderId ?? null,
        p.markProcessed?.resultStatus ?? null,
        p.requeue === true ? 1 : 0
      )
      .run()
  );
  return (res.meta?.changes ?? 0) > 0;
}

export async function d1InboxStuck(db: InboxD1, cutoffMs: number, limit: number) {
  const r = await guarded(() =>
    db
      .prepare(
        `SELECT id, provider, idempotency_key, store_id, status, attempts, received_at FROM webhook_events
          WHERE status IN ('received', 'processing') AND received_at < ?1 ORDER BY received_at ASC LIMIT ?2`
      )
      .bind(cutoffMs, Math.max(limit, 0))
      .all<InboxRowRaw>()
  );
  return r.results ?? [];
}

export async function d1InboxList(
  db: InboxD1,
  f: { status?: string; provider?: string; limit: number; offset: number }
) {
  const where = `(?1 IS NULL OR status = ?1) AND (?2 IS NULL OR provider = ?2)`;
  const rows = await guarded(() =>
    db
      .prepare(
        `SELECT id, provider, store_id, status, attempts, last_error, result_order_id, result_status, idempotency_key, received_at
           FROM webhook_events WHERE ${where} ORDER BY received_at DESC LIMIT ?3 OFFSET ?4`
      )
      .bind(f.status ?? null, f.provider ?? null, Math.max(f.limit, 0), Math.max(f.offset, 0))
      .all<InboxRowRaw>()
  );
  const total = await guarded(() =>
    db
      .prepare(`SELECT count(*) AS n FROM webhook_events WHERE ${where}`)
      .bind(f.status ?? null, f.provider ?? null)
      .first<{ n: number }>()
  );
  return { rows: rows.results ?? [], total: Number(total?.n ?? 0) };
}
