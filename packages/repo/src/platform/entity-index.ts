// Entity index (Phase 3.5): lookup of "which store owns this id" for webhooks and cross-store routes, replacing the
// ebda_*_store_id SECURITY DEFINER functions. The StoreDO queues `entity_index` rows in `d1_outbox` in the SAME section
// that creates the entity (see payments.ts `indexEntity`); `drainEntityIndexOutbox` (called from the DO alarm) writes them
// to D1 `entity_index` and retries with backoff until D1 acknowledges. The D1 side is write-once per (kind, id): an id can
// never be re-pointed at another store (a hostile or buggy second writer is reported, not applied).
import type { SyncSql } from '../do/sync-sql';

export const ENTITY_KINDS = [
  'order',
  'payment',
  'shipment',
  'customer',
  'return',
  'refund',
  'webhook',
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

const BACKOFF_BASE_MS = 1000;
const BACKOFF_MAX_MS = 60 * 60 * 1000;
export const backoffMs = (attempts: number): number =>
  Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** Math.min(attempts, 20));

export interface DrainResult {
  written: number;
  failed: number;
  /** an id already points at ANOTHER store: not applied, needs a human */
  conflicts: Array<{ kind: string; id: string; existing: string; attempted: string }>;
}

/** Write due outbox rows to D1. Idempotent: a retry after a lost acknowledgement finds the same row and succeeds. */
export async function drainEntityIndexOutbox(
  db: SyncSql,
  d1: D1Like,
  opts: { now?: number; limit?: number } = {}
): Promise<DrainResult> {
  const now = opts.now ?? Date.now();
  const rows = db.all(
    "SELECT id, payload, attempts FROM d1_outbox WHERE kind = 'entity_index' AND done_at IS NULL AND next_attempt_at <= ? ORDER BY id LIMIT ?",
    [now, Math.min(opts.limit ?? 100, 500)]
  );
  const out: DrainResult = { written: 0, failed: 0, conflicts: [] };
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
      const attempts = (r.attempts as number) + 1;
      db.run('UPDATE d1_outbox SET attempts = ?, next_attempt_at = ? WHERE id = ?', [
        attempts,
        now + backoffMs(attempts),
        rowId,
      ]);
      out.failed++;
    }
  }
  return out;
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

export type WebhookRoute = { storeId: string } | { noop: true; reason: 'unknown_reference' };
/**
 * Route a provider webhook to its store from the payment reference it carries (transaction / invoice / merchant ref,
 * indexed as `webhook` `<provider>:<ref>`, or a payment id). An unknown reference is a 200 no-op for the provider
 * (the caller adds a breadcrumb), never a crash and never a default store (tenant-resolver rule).
 */
export async function routePaymentWebhook(
  d1: D1Like,
  provider: string,
  ref: string
): Promise<WebhookRoute> {
  const storeId =
    (await resolveStoreId(d1, 'webhook', `${provider}:${ref}`)) ??
    (await resolveStoreId(d1, 'payment', ref));
  return storeId ? { storeId } : { noop: true, reason: 'unknown_reference' };
}
