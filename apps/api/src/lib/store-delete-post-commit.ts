/**
 * What a store DELETION does after its Postgres transaction committed (Rulings NZ-D14, NZ-D15, NZ-D17): the D1 directory row stops
 * resolving. MARKED deleted for a DO store (its data is retained and the StoreDO was already CLOSED atomically BEFORE the Postgres
 * delete, by `closeDoIfNoMoney`), removed for a Postgres store. There is no code path here that wipes a DO. A physical purge is a
 * separate retention job after the legal period (plan N-24).
 * Retries (idempotent); a persistent failure is a P1 alert naming the store, because a deleted store that keeps resolving fails OPEN
 * and the reconciler never deletes a `do` row.
 */
import logger from './logger';
import { sendAlert } from '../services/alerts.service';
import { retireStoreDirectoryRow } from './store-directory-sync';

const ATTEMPTS = 3;

export async function finishStoreDeletion(
  input: { storeId: string; wasOnDo: boolean },
  deps: {
    retireDirectory?: (id: string, opts: { soft: boolean }) => Promise<void>;
    alert?: (title: string, body: string) => Promise<unknown> | unknown;
  } = {}
): Promise<{ directory: boolean }> {
  const retire = deps.retireDirectory ?? retireStoreDirectoryRow;
  const alert =
    deps.alert ??
    ((title: string, body: string) =>
      sendAlert({ level: 'p1', source: 'store.delete.post_commit', title, body }));
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    try {
      await retire(input.storeId, { soft: input.wasOnDo });
      return { directory: true };
    } catch (err) {
      logger.warn(
        { err, storeId: input.storeId, attempt },
        '[STORE_DELETE] directory retire failed'
      );
    }
  }
  await alert(
    'Deleted store still resolvable (D1 directory row not retired)',
    `store ${input.storeId}: D1 update failed ${ATTEMPTS}x; mark or remove the stores row by hand.`
  );
  return { directory: false };
}
