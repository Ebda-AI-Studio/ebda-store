import { AsyncLocalStorage } from 'node:async_hooks';
import { hasTenantContext } from '@ebda/database';
import { cfBindings } from '../cf/bindings';
import { deferAfterTenantCommit, hasDeferralScope } from './after-tenant-commit';
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

/**
 * Releasing a claim is only safe AFTER the Postgres write that freed the reference has COMMITTED: if that transaction rolls
 * back the reference is still held in Postgres, and a claim freed early lets the same bank reference be filed again.
 * `scheduleClaimRelease` therefore never releases on its own: it queues into the nearest `withClaimReleases` scope and REFUSES
 * without one (throws outside production; in production it logs a P1 and releases nothing, so the claim stays held: fail closed).
 */
export interface ClaimRef {
  referenceKey: string;
  storeId: string;
  receiptId: string;
}
const releaseScope = new AsyncLocalStorage<{ pending: ClaimRef[] }>();

/**
 * Run `fn` (which owns or joins the transaction that frees references) and release the queued claims once it has committed:
 * after the enclosing request transaction commits (deferred, dropped on rollback), or right after `fn` resolves when `fn` opened
 * and closed its own transaction. A throw from `fn` drops the queue. Inside an open transaction that has NO deferral scope the
 * commit point is unknowable, so the release is refused instead of guessed.
 */
export async function withClaimReleases<T>(fn: () => Promise<T>): Promise<T> {
  const scope = { pending: [] as ClaimRef[] };
  const out = await releaseScope.run(scope, fn);
  if (scope.pending.length === 0) return out;
  const release = async () => {
    for (const c of scope.pending)
      await releaseInstapayReference(c.referenceKey, c.storeId, c.receiptId);
  };
  if (hasDeferralScope()) await deferAfterTenantCommit('instapay-ref-release', release);
  else if (hasTenantContext())
    refuseRelease(scope.pending, 'inside a transaction with no deferral scope');
  else await release();
  return out;
}

function refuseRelease(refs: ClaimRef[], why: string): void {
  const stores = Array.from(new Set(refs.map(r => r.storeId)));
  logger.error(
    { stores, count: refs.length, why },
    '[P1][instapay-ref] claim release refused: the commit point is unknown; the claims stay held'
  );
  if (process.env.NODE_ENV !== 'production')
    throw new Error(
      `instapay reference release refused (${why}): wrap the caller in withClaimReleases`
    );
}

/** Queue claims to free after the surrounding transaction commits. Refuses (see above) outside `withClaimReleases`. */
export function scheduleClaimRelease(refs: ClaimRef[]): void {
  if (refs.length === 0) return;
  const scope = releaseScope.getStore();
  if (!scope) return refuseRelease(refs, 'no withClaimReleases scope');
  scope.pending.push(...refs);
}
