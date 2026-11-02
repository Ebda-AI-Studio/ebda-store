/**
 * Durable retry for a post-commit D1 / DO Store sync (Ruling NZ-D20, supersedes the NZ-D19 versioned patch retry).
 *
 * A DO-store entitlement change (plan, billing suspension, status, deletion) made inside a transaction is committed to Postgres in
 * that transaction and copied to D1 + the DO AFTER it commits (lib/repo-factory.ts `syncStoreEntitlement`). If the copy fails it is
 * (1) logged and ALERTED, and (2) put on the jobs queue as `{storeId}` ONLY. The handler never replays a patch: it re-reads the
 * CURRENT committed row and copies the full state, so the retry is idempotent and latest-state-wins (no version, no clock).
 * The hourly directory reconciler additionally covers the directory columns of Postgres-backed stores.
 */
import logger from './logger';
import { sendAlert } from '../services/alerts.service';
import { cfBindings } from '../cf/bindings';

export interface StoreUpdateRetryMessage {
  kind: 'store-update-retry';
  storeId: string;
}

export const isStoreUpdateRetry = (v: unknown): v is StoreUpdateRetryMessage =>
  typeof v === 'object' &&
  v !== null &&
  (v as { kind?: unknown }).kind === 'store-update-retry' &&
  typeof (v as { storeId?: unknown }).storeId === 'string';

/** Delivery attempts before the queue dead-letters the message (alerted by the dead-letter handler). */
export const STORE_UPDATE_RETRY_MAX_ATTEMPTS = 8;

type Alert = (title: string, body: string) => Promise<unknown> | unknown;
const defaultAlert: Alert = (title, body) =>
  sendAlert({ level: 'p1', source: 'store.update.post_commit', title, body });

/** Log + alert a post-commit write that failed and has NO retry (profile / config fields of a deferred patch). Never throws. */
export async function reportStoreUpdateFailure(
  storeId: string,
  fields: string[],
  err: unknown,
  deps: { alert?: Alert } = {}
): Promise<void> {
  const message = err instanceof Error ? err.message : String(err);
  logger.error({ err, storeId, fields }, '[store-update] post-commit D1/DO write FAILED');
  await Promise.resolve(
    (deps.alert ?? defaultAlert)(
      'Store update committed in Postgres but the D1/DO write failed',
      `store ${storeId} fields ${fields.join(', ')}: ${message}. NO RETRY: apply the change by hand.`
    )
  ).catch(() => undefined);
}

/** Log + alert a failed post-commit entitlement sync and enqueue its retry (`{storeId}` only). Never throws. */
export async function reportAndRetryStoreUpdate(
  storeId: string,
  err: unknown,
  deps: { enqueue?: (m: StoreUpdateRetryMessage) => Promise<void>; alert?: Alert } = {}
): Promise<{ enqueued: boolean }> {
  const message = err instanceof Error ? err.message : String(err);
  logger.error({ err, storeId }, '[store-update] post-commit D1/DO sync FAILED');
  const enqueue =
    deps.enqueue ??
    (async (m: StoreUpdateRetryMessage) => {
      const q = cfBindings()?.JOBS_QUEUE;
      if (!q) throw new Error('JOBS_QUEUE binding missing');
      await q.send(m, { contentType: 'json' });
    });
  let enqueued = false;
  try {
    await enqueue({ kind: 'store-update-retry', storeId });
    enqueued = true;
  } catch (e) {
    logger.error({ err: e, storeId }, '[store-update] retry could not be enqueued');
  }
  await Promise.resolve(
    (deps.alert ?? defaultAlert)(
      'Store update committed in Postgres but the D1/DO sync failed',
      `store ${storeId}: ${message}. ${
        enqueued ? 'A retry is queued.' : 'NO RETRY QUEUED: re-sync the store by hand.'
      }`
    )
  ).catch(() => undefined);
  return { enqueued };
}

/**
 * Queue handler for one retry message. `sync` re-reads the CURRENT committed state and copies it to D1 + the DO (Ruling NZ-D20): no
 * patch, no version, so a late, duplicated or concurrent retry converges on the latest state. Returns `done` or `retry` (backoff).
 */
export async function applyStoreUpdateRetry(
  m: StoreUpdateRetryMessage,
  deps: { sync: (storeId: string) => Promise<void> }
): Promise<'done' | 'retry'> {
  try {
    await deps.sync(m.storeId);
    return 'done';
  } catch (err) {
    logger.warn({ err, storeId: m.storeId }, '[store-update] retry failed; will redeliver');
    return 'retry';
  }
}
