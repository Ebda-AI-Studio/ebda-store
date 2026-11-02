/**
 * Durable retry for a post-commit D1 / DO Store write (Ruling NZ-D19 follow-up, security review).
 *
 * A DO-store entitlement change (plan, billing suspension, status) made inside a transaction is applied AFTER that transaction
 * commits (lib/repo-factory.ts). Postgres has then already committed, so a failure of the D1 / DO write must not be lost: it is
 * (1) logged and ALERTED, and (2) put on the existing jobs queue as a `store-update-retry` message, redelivered with backoff until it
 * lands. The patch is ABSOLUTE (final values, not deltas), so a replay converges; a message is skipped when a NEWER write already
 * changed the store (`stores.updated_at` in D1 is after the message's `at`), so a late retry cannot undo a later update.
 * The hourly directory reconciler additionally covers the directory columns (plan, status, slug, domain) of Postgres-backed stores.
 */
import logger from './logger';
import { sendAlert } from '../services/alerts.service';
import { cfBindings } from '../cf/bindings';

export interface StoreUpdateRetryMessage {
  kind: 'store-update-retry';
  storeId: string;
  data: Record<string, unknown>;
  /** ms epoch of the commit that produced this patch. */
  at: number;
}

export const isStoreUpdateRetry = (v: unknown): v is StoreUpdateRetryMessage =>
  typeof v === 'object' &&
  v !== null &&
  (v as { kind?: unknown }).kind === 'store-update-retry' &&
  typeof (v as { storeId?: unknown }).storeId === 'string' &&
  typeof (v as { at?: unknown }).at === 'number' &&
  typeof (v as { data?: unknown }).data === 'object';

/** Delivery attempts before the queue dead-letters the message (alerted by the dead-letter handler). */
export const STORE_UPDATE_RETRY_MAX_ATTEMPTS = 8;

/** Log + alert a failed post-commit write and enqueue its retry. Never throws (the transaction already committed). */
export async function reportAndRetryStoreUpdate(
  storeId: string,
  data: Record<string, unknown>,
  err: unknown,
  deps: {
    enqueue?: (m: StoreUpdateRetryMessage) => Promise<void>;
    alert?: (title: string, body: string) => Promise<unknown> | unknown;
    now?: () => number;
  } = {}
): Promise<{ enqueued: boolean }> {
  const message = err instanceof Error ? err.message : String(err);
  logger.error(
    { err, storeId, fields: Object.keys(data) },
    '[store-update] post-commit D1/DO write FAILED'
  );
  const alert =
    deps.alert ??
    ((title: string, body: string) =>
      sendAlert({ level: 'p1', source: 'store.update.post_commit', title, body }));
  const enqueue =
    deps.enqueue ??
    (async (m: StoreUpdateRetryMessage) => {
      const q = cfBindings()?.JOBS_QUEUE;
      if (!q) throw new Error('JOBS_QUEUE binding missing');
      await q.send(m, { contentType: 'json' });
    });
  let enqueued = false;
  try {
    await enqueue({ kind: 'store-update-retry', storeId, data, at: (deps.now ?? Date.now)() });
    enqueued = true;
  } catch (e) {
    logger.error({ err: e, storeId }, '[store-update] retry could not be enqueued');
  }
  await Promise.resolve(
    alert(
      'Store update committed in Postgres but the D1/DO write failed',
      `store ${storeId} fields ${Object.keys(data).join(', ')}: ${message}. ${
        enqueued ? 'A retry is queued.' : 'NO RETRY QUEUED: apply the change by hand.'
      }`
    )
  ).catch(() => undefined);
  return { enqueued };
}

/**
 * Queue handler for one retry message. Returns what the caller should do with the delivery:
 * `done` (applied, or superseded by a newer write) or `retry` (try again with backoff).
 */
export async function applyStoreUpdateRetry(
  m: StoreUpdateRetryMessage,
  deps: {
    apply: (storeId: string, data: Record<string, unknown>) => Promise<void>;
    updatedAt: (storeId: string) => Promise<number | null>;
  }
): Promise<'done' | 'retry'> {
  try {
    const newest = await deps.updatedAt(m.storeId);
    if (newest !== null && newest > m.at) return 'done'; // a newer write already changed the store: never undo it
    await deps.apply(m.storeId, m.data);
    return 'done';
  } catch (err) {
    logger.warn({ err, storeId: m.storeId }, '[store-update] retry failed; will redeliver');
    return 'retry';
  }
}
