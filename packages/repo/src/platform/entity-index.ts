// Entity index (Phase 3.5): lookup of "which store owns this id" for webhooks and cross-store routes, replacing the
// ebda_*_store_id SECURITY DEFINER functions. The StoreDO queues `entity_index` rows in `d1_outbox` in the SAME section
// that creates the entity (see payments.ts `indexEntity`); `drainEntityIndexOutbox` (called from the DO alarm) writes them
// to D1 `entity_index` and retries with backoff until D1 acknowledges. The D1 side is write-once per (kind, id): an id can
// never be re-pointed at another store (a hostile or buggy second writer is reported, not applied).
import { createPayment } from '../do/payments';
import { MoneyError, type SyncSql } from '../do/sync-sql';

export const ENTITY_KINDS = [
  'order',
  'payment',
  'shipment',
  'customer',
  'return',
  'refund',
  'webhook',
  'instapay_ref',
] as const;
export type EntityKind = (typeof ENTITY_KINDS)[number];

/** The slice of a D1 binding used here (D1Database / a test double). */
export interface D1Like {
  prepare(sql: string): {
    bind(...values: unknown[]): {
      run(): Promise<{ meta?: { changes?: number } }>;
      first<T = Record<string, unknown>>(): Promise<T | null>;
    };
  };
}

/** After this many failures a row is dead-lettered (still in the outbox, no longer retried, counted for the alert). */
export const MAX_ATTEMPTS = 20;
const BACKOFF_BASE_MS = 1000;
const BACKOFF_MAX_MS = 60 * 60 * 1000;
export const backoffMs = (attempts: number): number =>
  Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** Math.min(attempts, 20));

export interface DrainResult {
  written: number;
  failed: number;
  /** rows that failed MAX_ATTEMPTS times: off the fast path; the alarm still retries them hourly (`includeDead`); alert */
  deadLettered: number;
  /** rows that crossed MAX_ATTEMPTS in THIS drain: the caller alerts once (Ruling NZ-MONEY-2) */
  newlyDead: number;
  /** an id already points at ANOTHER store: not applied, needs a human */
  conflicts: Array<{ kind: string; id: string; existing: string; attempted: string }>;
}

/** Write due outbox rows to D1. Idempotent: a retry after a lost acknowledgement finds the same row and succeeds. */
export async function drainEntityIndexOutbox(
  db: SyncSql,
  d1: D1Like,
  opts: {
    now?: number;
    limit?: number;
    afterId?: number;
    onlyIds?: readonly string[];
    /** the alarm: dead-lettered rows are retried too (on their capped 1 h backoff); a money row is never abandoned */
    includeDead?: boolean;
  } = {}
): Promise<DrainResult> {
  const now = opts.now ?? Date.now();
  // `afterId`: only the rows queued after that outbox id (a money op drains ITS OWN rows first, ahead of any backlog).
  // `onlyIds`: a FORCED drain of these entity ids (a reference about to be handed out is written NOW): due or not,
  // dead-lettered or not (revived on demand), and a failure does NOT count toward the dead-letter limit, so shopper retries
  // during an outage can never dead-letter the row (review NEW-3 of PR 455). Only the paced drains count attempts.
  const only = opts.onlyIds && opts.onlyIds.length > 0 ? opts.onlyIds.slice(0, 50) : null;
  const rows = only
    ? db.all(
        `SELECT id, payload, attempts FROM d1_outbox WHERE kind = 'entity_index' AND done_at IS NULL AND json_extract(payload, '$.id') IN (${only.map(() => '?').join(', ')}) ORDER BY id`,
        [...only]
      )
    : db.all(
        "SELECT id, payload, attempts FROM d1_outbox WHERE kind = 'entity_index' AND done_at IS NULL AND (attempts < ? OR ?) AND next_attempt_at <= ? AND id > ? ORDER BY id LIMIT ?",
        [
          MAX_ATTEMPTS,
          opts.includeDead ? 1 : 0,
          now,
          opts.afterId ?? 0,
          Math.min(opts.limit ?? 100, 500),
        ]
      );
  const out: DrainResult = { written: 0, failed: 0, deadLettered: 0, newlyDead: 0, conflicts: [] };
  for (const r of rows) {
    const rowId = r.id as number;
    try {
      const p = JSON.parse(r.payload as string) as { kind: string; id: string; storeId: string };
      if (!ENTITY_KINDS.includes(p.kind as EntityKind) || !p.id || !p.storeId)
        throw new Error('malformed entity_index payload');
      await d1
        .prepare(
          'INSERT INTO entity_index (kind, id, store_id) VALUES (?, ?, ?) ON CONFLICT (kind, id) DO NOTHING'
        )
        .bind(p.kind, p.id, p.storeId)
        .run();
      const have = await d1
        .prepare('SELECT store_id FROM entity_index WHERE kind = ? AND id = ?')
        .bind(p.kind, p.id)
        .first<{ store_id: string }>();
      if (!have) throw new Error('entity_index row not visible after write');
      if (have.store_id !== p.storeId)
        out.conflicts.push({
          kind: p.kind,
          id: p.id,
          existing: have.store_id,
          attempted: p.storeId,
        });
      db.run('UPDATE d1_outbox SET done_at = ? WHERE id = ?', [now, rowId]);
      out.written++;
    } catch {
      out.failed++;
      if (only) continue; // a forced drain neither counts nor reschedules (see above)
      const attempts = (r.attempts as number) + 1;
      db.run('UPDATE d1_outbox SET attempts = ?, next_attempt_at = ? WHERE id = ?', [
        attempts,
        now + backoffMs(attempts),
        rowId,
      ]);
      if (attempts >= MAX_ATTEMPTS) out.deadLettered++;
      if (attempts === MAX_ATTEMPTS) out.newlyDead++;
    }
  }
  return out;
}

/**
 * The entity-index ids a payment must have in D1 before its reference is handed out: the payment id and each gateway reference
 * (`<provider>:<ref>`). Empty when the payment is not this store's.
 */
export function paymentIndexIds(
  db: SyncSql,
  storeId: string,
  paymentId: string
): Array<{ kind: EntityKind; id: string }> {
  const p = db.all(
    'SELECT p.id, p.provider, p.transaction_id, p.invoice_id FROM payments p JOIN orders o ON o.id = p.order_id WHERE p.id = ? AND o.store_id = ?',
    [paymentId, storeId]
  )[0];
  if (!p) return [];
  const ids: Array<{ kind: EntityKind; id: string }> = [{ kind: 'payment', id: p.id as string }];
  // only a GATEWAY payment has webhook references (cod has none; an InstaPay transfer is confirmed by the merchant, its
  // reference is never routed by a webhook and never indexed)
  if (p.provider !== 'cod' && p.provider !== 'instapay')
    for (const ref of [p.transaction_id, p.invoice_id])
      if (typeof ref === 'string' && ref)
        ids.push({ kind: 'webhook', id: `${p.provider as string}:${ref}` });
  return ids;
}

/** The highest outbox id so far (0 when empty): a money op's OWN index rows are the ones queued after it. */
export function outboxHighWater(db: SyncSql): number {
  return (db.all('SELECT COALESCE(MAX(id), 0) AS m FROM d1_outbox', [])[0]?.m as number) ?? 0;
}

/** The {kind, id} of the entity-index rows queued after `afterId` (a money op's own rows). */
export function outboxRowsAfter(
  db: SyncSql,
  afterId: number
): Array<{ kind: EntityKind; id: string }> {
  return db
    .all("SELECT payload FROM d1_outbox WHERE kind = 'entity_index' AND id > ? ORDER BY id", [
      afterId,
    ])
    .map(r => JSON.parse(r.payload as string) as { kind: EntityKind; id: string })
    .map(p => ({ kind: p.kind, id: p.id }));
}

/** When the next undone, not dead-lettered row is due (epoch ms), or null when the outbox is drained. */
export function nextOutboxAttempt(db: SyncSql): number | null {
  const r = db.all(
    // dead-lettered rows included: the alarm keeps retrying them on their capped (1 h) backoff
    "SELECT MIN(next_attempt_at) AS t FROM d1_outbox WHERE kind = 'entity_index' AND done_at IS NULL",
    []
  )[0];
  return (r?.t as number | null) ?? null;
}

/** The store that owns an entity, or null (unknown id). */
export async function resolveStoreId(
  d1: D1Like,
  kind: EntityKind,
  id: string
): Promise<string | null> {
  if (!ENTITY_KINDS.includes(kind) || typeof id !== 'string' || id.length === 0 || id.length > 300)
    return null;
  const r = await d1
    .prepare('SELECT store_id FROM entity_index WHERE kind = ? AND id = ?')
    .bind(kind, id)
    .first<{ store_id: string }>();
  return r?.store_id ?? null;
}

/**
 * `retry`: the reference is not (yet) in the index. NEVER answer the gateway 2xx for this: a callback that outruns the
 * D1 write (alarm lag, a D1 blip) would be acknowledged and dropped, the gateway would never retry and the order would
 * stay unpaid although the customer paid (audit DB-2). The route answers non-2xx (`webhookHttpResponse`) so the gateway
 * retries, and alerts so an operator sees a reference that never resolves.
 */
export type WebhookRoute = { storeId: string } | { retry: true; reason: 'unresolved_reference' };

/**
 * Route a provider webhook to its store from the payment reference it carries (transaction / invoice / merchant ref,
 * indexed as `webhook` `<provider>:<ref>`, or a payment id). An unresolved reference is `retry`, never a default store
 * (tenant-resolver rule) and never a silent 2xx.
 */
export async function routePaymentWebhook(
  d1: D1Like,
  provider: string,
  ref: string
): Promise<WebhookRoute> {
  const storeId =
    (await resolveStoreId(d1, 'webhook', `${provider}:${ref}`)) ??
    (await resolveStoreId(d1, 'payment', ref));
  return storeId ? { storeId } : { retry: true, reason: 'unresolved_reference' };
}

export interface WebhookHttpResponse {
  status: number;
  headers: Record<string, string>;
  body: { status: 'retry' };
  /** raise this (P1 after the gateway has retried a few times): the reference never resolved */
  alert: { kind: 'webhook_unresolved_reference'; provider: string };
}
/** The HTTP answer for an unresolved route: 503 + Retry-After so the gateway retries; nothing about the store is revealed. */
export function webhookHttpResponse(
  route: Extract<WebhookRoute, { retry: true }>,
  provider: string
): WebhookHttpResponse {
  void route;
  return {
    status: 503,
    headers: { 'Retry-After': '30' },
    body: { status: 'retry' },
    alert: { kind: 'webhook_unresolved_reference', provider },
  };
}

/**
 * Make the entity-index rows for `ids` visible in D1 NOW (not on the next alarm): drain the outbox, then verify every id is
 * done. Call it BEFORE the payment url / provider reference is handed out, so a callback can never outrun the index. Throws a
 * 503 `ENTITY_INDEX_UNAVAILABLE` when D1 cannot take the rows (the caller must then not hand the reference out; the rows stay
 * queued and the alarm keeps retrying).
 */
export async function awaitEntityIndexed(
  db: SyncSql,
  d1: D1Like,
  storeId: string,
  ids: ReadonlyArray<{ kind: EntityKind; id: string }>,
  opts: { now?: number; afterId?: number; limit?: number } = {}
): Promise<void> {
  if (!storeId) throw new MoneyError('STORE_REQUIRED', 'storeId is required', 500);
  const now = opts.now ?? Date.now();
  const drained = await drainEntityIndexOutbox(db, d1, {
    now: now + 1,
    afterId: opts.afterId,
    limit: opts.limit,
  });
  // an id already owned by ANOTHER store is a conflict, not "done": routing it would deliver this payment to the wrong tenant
  const conflicted = ids.filter(w =>
    drained.conflicts.some(c => c.kind === w.kind && c.id === w.id)
  );
  if (conflicted.length > 0)
    throw new MoneyError(
      'ENTITY_INDEX_CONFLICT',
      'an entity id is already owned by another store',
      409,
      {
        conflicts: conflicted.length,
      }
    );
  const pending = db
    .all("SELECT payload FROM d1_outbox WHERE kind = 'entity_index' AND done_at IS NULL", [])
    .map(r => JSON.parse(r.payload as string) as { kind: string; id: string });
  const missing = ids.filter(w => pending.some(p => p.kind === w.kind && p.id === w.id));
  if (missing.length > 0)
    throw new MoneyError(
      'ENTITY_INDEX_UNAVAILABLE',
      'the entity index could not be written; try again',
      503,
      {
        missing: missing.length,
      }
    );
  // fail closed: read every id back from D1 and require it to resolve to THIS store (covers a conflict recorded by an earlier
  // drain, and an id that was never queued)
  for (const w of ids) {
    const owner = await resolveStoreId(d1, w.kind, w.id);
    if (owner !== storeId)
      throw new MoneyError(
        owner === null ? 'ENTITY_INDEX_UNAVAILABLE' : 'ENTITY_INDEX_CONFLICT',
        owner === null
          ? 'the entity index has no row for this id'
          : 'an entity id is owned by another store',
        owner === null ? 503 : 409
      );
  }
}

/** Create the payment AND make it routable before returning (the caller then hands the provider reference out). */
export async function createPaymentIndexed(
  db: SyncSql,
  d1: D1Like,
  args: Parameters<typeof createPayment>[1]
): Promise<{ paymentId: string }> {
  const { paymentId } = createPayment(db, args);
  const ids: Array<{ kind: EntityKind; id: string }> = [{ kind: 'payment', id: paymentId }];
  for (const ref of [args.transactionId, args.invoiceId])
    if (ref) ids.push({ kind: 'webhook', id: `${args.provider}:${ref}` });
  await awaitEntityIndexed(db, d1, args.storeId, ids, { now: args.now });
  return { paymentId };
}
