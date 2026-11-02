/**
 * Durable retry for a post-commit D1 / DO Store write (Ruling NZ-D19 follow-up, security review).
 *
 * A DO-store entitlement change (plan, billing suspension, status) made inside a transaction is applied AFTER that transaction
 * commits (lib/repo-factory.ts). Postgres has then already committed, so a failure of the D1 / DO write must not be lost: it is
 * (1) logged and ALERTED, and (2) put on the existing jobs queue as a `store-update-retry` message, redelivered with backoff until it
 * lands. The patch is ABSOLUTE (final values, not deltas), so a replay converges; a message is skipped when a NEWER write already
 * changed the store (D1 `stores.updated_at` carries the version of the last applied write; the retry applies only when its `version` is newer), so a late retry cannot undo a later update.
 * The hourly directory reconciler additionally covers the directory columns (plan, status, slug, domain) of Postgres-backed stores.
 */
import logger from './logger';
import { sendAlert } from '../services/alerts.service';
import { cfBindings } from '../cf/bindings';

export interface StoreUpdateRetryMessage {
  kind: 'store-update-retry';
  storeId: string;
  data: Record<string, unknown>;
  /** Monotonic commit-time version of the write that produced this patch (see `storeUpdateVersioned`). */
  version: number;
}

export const isStoreUpdateRetry = (v: unknown): v is StoreUpdateRetryMessage =>
  typeof v === 'object' &&
  v !== null &&
  (v as { kind?: unknown }).kind === 'store-update-retry' &&
  typeof (v as { storeId?: unknown }).storeId === 'string' &&
  typeof (v as { version?: unknown }).version === 'number' &&
  typeof (v as { data?: unknown }).data === 'object';

/** Delivery attempts before the queue dead-letters the message (alerted by the dead-letter handler). */
export const STORE_UPDATE_RETRY_MAX_ATTEMPTS = 8;

/** Log + alert a failed post-commit write and enqueue its retry. Never throws (the transaction already committed). */
export async function reportAndRetryStoreUpdate(
  storeId: string,
  data: Record<string, unknown>,
  err: unknown,
  stamp: { version: number },
  deps: {
    enqueue?: (m: StoreUpdateRetryMessage) => Promise<void>;
    alert?: (title: string, body: string) => Promise<unknown> | unknown;
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
    await enqueue({ kind: 'store-update-retry', storeId, data, version: stamp.version });
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
 * Queue handler for one retry message. `apply` is the VERSIONED write (`storeUpdateVersioned`): it skips itself when a write with an
 * equal-or-newer version already landed, so a late retry can never undo a later update. Returns what the caller should do with the
 * delivery: `done` (applied, or superseded) or `retry` (try again with backoff).
 */
export async function applyStoreUpdateRetry(
  m: StoreUpdateRetryMessage,
  deps: {
    apply: (
      storeId: string,
      data: Record<string, unknown>,
      version: number
    ) => Promise<'applied' | 'skipped'>;
  }
): Promise<'done' | 'retry'> {
  try {
    await deps.apply(m.storeId, m.data, m.version);
    return 'done';
  } catch (err) {
    logger.warn({ err, storeId: m.storeId }, '[store-update] retry failed; will redeliver');
    return 'retry';
  }
}
