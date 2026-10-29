import { cfBindings } from '../cf/bindings';
import logger from './logger';

/**
 * The cross-store half of the InstaPay reference uniqueness for DO stores (Ruling INSTAPAY-DO-1). The same-store half is
 * the DO's partial unique index; this is a SYNCHRONOUS claim in D1 `entity_index` (kind `instapay_ref`, id = the normalised
 * reference, write-once per (kind, id)) made BEFORE the DO section, so two DO stores cannot both submit one reference.
 * Without a D1 binding (Postgres-only environments, tests) there is nothing to claim and the DO index alone decides.
 *
 * RESIDUAL (documented in INSTAPAY-DO-1): a reference held by a Postgres-backed receipt (a subscription receipt or a
 * Postgres store's order receipt) is invisible here, because Postgres RLS hides other stores' rows from a SELECT and its
 * UNIQUE index is only reachable by writing. It closes when the receipts table moves to D1 at the billing cutover.
 */
type D1 = {
  prepare(sql: string): {
    bind(...v: unknown[]): {
      run(): Promise<{ meta?: { changes?: number } }>;
      first<T = Record<string, unknown>>(): Promise<T | null>;
    };
  };
};
const d1 = (): D1 | undefined => (cfBindings() as { PLATFORM_DB?: D1 } | undefined)?.PLATFORM_DB;

/**
 * A claim is BOUND to the receipt that made it (`claim_ref`): only that receipt can see it as its own, and only that receipt
 * can free it. 'taken' = another store, or another receipt of this store, holds the reference.
 */
export type RefClaim = 'claimed' | 'ours' | 'taken' | 'unavailable';

export async function claimInstapayReference(
  referenceKey: string,
  storeId: string,
  receiptId: string
): Promise<RefClaim> {
  const db = d1();
  if (!db) return 'unavailable';
  const ins = await db
    .prepare(
      "INSERT OR IGNORE INTO entity_index (kind, id, store_id, claim_ref) VALUES ('instapay_ref', ?, ?, ?)"
    )
    .bind(referenceKey, storeId, receiptId)
    .run();
  if ((ins.meta?.changes ?? 0) > 0) return 'claimed';
  const row = await db
    .prepare("SELECT store_id, claim_ref FROM entity_index WHERE kind = 'instapay_ref' AND id = ?")
    .bind(referenceKey)
    .first<{ store_id: string; claim_ref: string | null }>();
  return row?.store_id === storeId && row.claim_ref === receiptId ? 'ours' : 'taken';
}

/**
 * Free a reference, but only the claim THIS receipt of THIS store holds (a rejected receipt; a submit the DO refused with a
 * rolled-back answer). A claim another receipt holds is never touched, so a late or repeated release cannot reopen a live
 * reference. Never call it after a duplicate refusal or a transport error (the outcome is not known to be "not submitted").
 */
export async function releaseInstapayReference(
  referenceKey: string,
  storeId: string,
  receiptId: string
): Promise<void> {
  const db = d1();
  if (!db) return;
  try {
    await db
      .prepare(
        "DELETE FROM entity_index WHERE kind = 'instapay_ref' AND id = ? AND store_id = ? AND claim_ref = ?"
      )
      .bind(referenceKey, storeId, receiptId)
      .run();
  } catch (err) {
    logger.error(
      { err, storeId },
      '[P1][instapay-ref] could not free a reference claim; it stays taken (fail closed) until cleared'
    );
  }
}
