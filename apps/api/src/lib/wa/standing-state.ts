/**
 * `store.suspended` / `store.reactivated` / `store.deleted` (contract v1.6, Ruling STORE-STANDING-1, issue #839): the store's
 * STANDING reaches Ebda Chat, which stops every send that costs money while the store is suspended or deleted. "May this store's
 * messaging spend" is a NEVER-stale class, so it is announced on EVERY write of `stores.status` / `deletedAt` and on every store
 * delete (the one database observer, `installWaWriteObservers`, which also sees D1-served writes through `notifyModelWrite`),
 * explicitly by the billing suspend / restore and the store delete, and re-sent by the 12-hourly reconcile as the net under them.
 *
 * The job reads the CURRENT standing when it runs and stamps it with that read time (`at`), so the newest read wins at Ebda Chat
 * whatever order the queue delivers in. Every run is its own envelope (the read time is in the seed): a suspend -> reactivate ->
 * suspend sequence can never be swallowed by the consumer's dedupe of an earlier identical envelope.
 */
import { withStore, type ModelWriteEvent } from '@ebda/database';
import { storeRepo } from '../repo-factory';
import { sendEventAfterCommit } from '../inngest/send-after-commit';
import logger from '../logger';
import type { StoreEventInput } from './events';

export const STANDING_CHANGED_EVENT = 'store/standing-changed';

/** The Store columns whose write can change whether a store stands (live, suspended, deleted). */
const STANDING_KEYS = new Set(['status', 'deletedAt', 'billingSuspendedReason']);

function keysOf(data: unknown): string[] {
  return data && typeof data === 'object' ? Object.keys(data as Record<string, unknown>) : [];
}
function str(v: unknown): string | null {
  return typeof v === 'string' && v ? v : null;
}

/** Which store (if any) a database write changes the STANDING of. Pure; the unit test drives it with every write shape. */
// pq-allow(unused-export): test seam, imported by tests/unit/wa-standing-state.test.ts
export function standingChangeStoreId(e: ModelWriteEvent): string | null {
  if (e.model !== 'Store') return null;
  const args = (e.args ?? {}) as { where?: Record<string, unknown>; data?: unknown };
  const result = (e.result ?? {}) as Record<string, unknown>;
  if (e.operation === 'delete') return str(args.where?.id) ?? str(result.id);
  if (e.operation === 'update' || e.operation === 'updateMany') {
    if (!keysOf(args.data).some(k => STANDING_KEYS.has(k))) return null;
    return str(args.where?.id) ?? str(result.id);
  }
  return null;
}

/** Ask the job to re-read this store's standing and tell Ebda Chat. `deleted`: the caller just deleted it (nothing left to read). Never throws. */
export async function notifyStandingChanged(
  storeId: string,
  opts: { deleted?: boolean } = {}
): Promise<void> {
  await sendEventAfterCommit(
    'wa-standing-changed',
    { name: STANDING_CHANGED_EVENT, data: { storeId, ...(opts.deleted ? { deleted: true } : {}) } },
    { ifUnhookable: 'send' }
  );
}

/** Called by the database observer (lib/wa/observers.ts) for every write. */
export function onStandingWrite(e: ModelWriteEvent): void {
  const storeId = standingChangeStoreId(e);
  if (!storeId) return;
  void notifyStandingChanged(storeId, { deleted: e.operation === 'delete' }).catch(err =>
    logger.warn({ err, storeId }, '[wa] standing notify failed (12-hourly reconcile covers it)')
  );
}

type StandingRow = {
  status: string;
  deletedAt: Date | null;
  billingSuspendedReason: string | null;
};

/**
 * The envelope input for a store's CURRENT standing. A store with no row (deleted) or a `deletedAt` is `store.deleted`; `suspended`
 * is `store.suspended` with the billing reason (`unpaid`, `over_store_limit`) or `admin` (a super admin's suspension, no billing
 * reason); `active` and `inactive` (paused by its merchant, not a spend risk) are `store.reactivated`. A read error throws (the job
 * retries): an unreadable store is never reported as deleted.
 */
export async function standingInput(
  storeId: string,
  opts: { deleted?: boolean; now?: Date } = {}
): Promise<{ input: StoreEventInput; seed: string; deleted: boolean }> {
  const now = opts.now ?? new Date();
  const at = now.toISOString();
  const select = { status: true, deletedAt: true, billingSuspendedReason: true } as const;
  const row: StandingRow | null = opts.deleted
    ? null
    : ((await storeRepo(storeId).then(repo =>
        repo.backend === 'do'
          ? repo.db.store.findUnique({ where: { id: storeId }, select })
          : withStore(storeId, tx => tx.store.findUnique({ where: { id: storeId }, select }))
      )) as StandingRow | null);
  const seed = (state: string) => `standing:${storeId}:${state}:${now.getTime()}`;
  if (!row || row.deletedAt) {
    return {
      deleted: true,
      seed: seed('deleted'),
      input: { type: 'store.deleted', storeId, data: { at } },
    };
  }
  if (row.status === 'suspended') {
    const reason =
      row.billingSuspendedReason === 'unpaid' || row.billingSuspendedReason === 'over_store_limit'
        ? row.billingSuspendedReason
        : 'admin';
    return {
      deleted: false,
      seed: seed(`suspended:${reason}`),
      input: { type: 'store.suspended', storeId, data: { reason, at } },
    };
  }
  return {
    deleted: false,
    seed: seed('live'),
    input: { type: 'store.reactivated', storeId, data: { at } },
  };
}
