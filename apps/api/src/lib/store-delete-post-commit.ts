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

/**
 * PDPL anonymisation of a DELETED DO store (Rulings FOLD-ERASURE-2, RETENTION-1): runs AFTER the delete committed, because it cannot
 * be rolled back (a failed delete reopens the DO; anonymised rows would stay anonymised). Three independent steps, each retried and
 * each a P1 alert when it cannot finish, none able to stop the others:
 *   1. the StoreDO: buyer + merchant contact data anonymised, account / cart / consent data deleted, fiscal / VAT / payment rows KEPT
 *   2. the platform D1 rows of the store (memberships, API keys, invitee addresses, card reference)
 *   3. the platform payer fields (InstaPay receipts, manual-payment claims), anonymised not deleted
 * Idempotent, so a retry or a second delete call converges.
 */
export async function anonymiseDeletedStore(
  storeId: string,
  deps: {
    eraseDo?: (
      storeId: string,
      requestId: string
    ) => Promise<{ refused?: unknown; remaining: number }>;
    eraseD1?: (storeId: string) => Promise<void>;
    erasePayments?: (storeId: string, requestId: string) => Promise<unknown>;
    alert?: (title: string, body: string) => Promise<unknown> | unknown;
    requestId?: string;
  }
): Promise<{ failed: string[] }> {
  const alert =
    deps.alert ??
    ((title: string, body: string) =>
      sendAlert({ level: 'p1', source: 'store.delete.anonymise', title, body }));
  const requestId = deps.requestId ?? `store-delete-${storeId}`;
  const failed: string[] = [];
  const step = async (name: string, fn: () => Promise<void>) => {
    for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
      try {
        await fn();
        return;
      } catch (err) {
        logger.warn({ err, storeId, attempt }, `[STORE_DELETE] anonymise ${name} failed`);
      }
    }
    failed.push(name);
  };
  if (deps.eraseDo) {
    const eraseDo = deps.eraseDo;
    await step('store-do', async () => {
      const r = await eraseDo(storeId, requestId);
      if (r.refused) throw new Error('refused: money in flight');
      if (r.remaining > 0) throw new Error(`${r.remaining} row(s) remain`);
    });
  }
  if (deps.eraseD1) {
    const eraseD1 = deps.eraseD1;
    await step('platform-d1', () => eraseD1(storeId));
  }
  if (deps.erasePayments) {
    const erasePayments = deps.erasePayments;
    await step('platform-payments', async () => void (await erasePayments(storeId, requestId)));
  }
  if (failed.length)
    await alert(
      'Deleted store still holds personal data',
      `store ${storeId}: anonymisation did not finish for: ${failed.join(', ')}. Re-run the delete (idempotent) or anonymise by hand.`
    );
  return { failed };
}
