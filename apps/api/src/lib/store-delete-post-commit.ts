/**
 * What a store DELETION must do after its Postgres transaction committed, so the deleted store stops being served (Rulings NZ-D14,
 * NZ-D15).
 *
 * Lookups read the D1 directory, and a store on its Durable Object keeps its data (payments, refunds, fiscal documents) in the DO.
 *   1. the D1 directory row stops resolving: MARKED deleted for a DO store (data retained), removed for a Postgres store;
 *   2. a store that was on its DO is CLOSED: write-refusing, read-only, NOTHING deleted. This module has no code path that wipes a
 *      DO. A physical purge is a separate retention job after the legal period (plan N-24).
 * Each step retries (idempotent). A step that still fails is a P1 alert naming the store, because a deleted store that keeps
 * resolving or writing fails OPEN; for a `do` store the reconciler never deletes a D1 row, so a human acts on the alert.
 */
import logger from './logger';
import { sendAlert } from '../services/alerts.service';
import { retireStoreDirectoryRow } from './store-directory-sync';
import { closeDoStore } from './repo-factory';

const ATTEMPTS = 3;

async function retried(step: string, storeId: string, fn: () => Promise<void>): Promise<boolean> {
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    try {
      await fn();
      return true;
    } catch (err) {
      logger.warn({ err, storeId, step, attempt }, '[STORE_DELETE] post-commit step failed');
    }
  }
  return false;
}

export async function finishStoreDeletion(
  input: { storeId: string; wasOnDo: boolean },
  deps: {
    retireDirectory?: (id: string, opts: { soft: boolean }) => Promise<void>;
    closeDo?: (id: string) => Promise<void>;
    alert?: (title: string, body: string) => Promise<unknown> | unknown;
  } = {}
): Promise<{ directory: boolean; closed: boolean | null }> {
  const retire = deps.retireDirectory ?? retireStoreDirectoryRow;
  const closeDo = deps.closeDo ?? closeDoStore;
  const alert =
    deps.alert ??
    ((title: string, body: string) =>
      sendAlert({ level: 'p1', source: 'store.delete.post_commit', title, body }));

  const directory = await retried('directory', input.storeId, () =>
    retire(input.storeId, { soft: input.wasOnDo })
  );
  if (!directory)
    await alert(
      'Deleted store still resolvable (D1 directory row not retired)',
      `store ${input.storeId}: D1 update failed ${ATTEMPTS}x; mark or remove the stores row by hand.`
    );
  let closed: boolean | null = null;
  if (input.wasOnDo) {
    closed = await retried('close-durable-object', input.storeId, () => closeDo(input.storeId));
    if (!closed)
      await alert(
        'Deleted store Durable Object not closed',
        `store ${input.storeId}: StoreDO close failed ${ATTEMPTS}x; it still accepts writes. Close it by hand.`
      );
  }
  return { directory, closed };
}
