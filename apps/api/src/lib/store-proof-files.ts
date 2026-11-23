/**
 * Delete the payment-proof FILES of a store that is being purged (Ruling NZ-D15B, follow-up of the #1109 review).
 * The tombstone clears the DATABASE columns that point at them (`manual_payment_claims.proof_url`, the receipt payer fields) but the
 * objects themselves, a screenshot of a bank transfer showing payer name, account and mobile, would stay in R2 for ever:
 *   - `instapay_receipts.storage_key`  private bucket, deleted unless `image_deleted_at` is already set (then marked)
 *   - `manual_payment_claims.proof_url` legacy public-bucket URL of an uploaded screenshot (no code writes it any more; read-only
 *     production check 2026-11-24: 0 of 1 claims has one), deleted when it maps to a key of THIS store, then cleared
 * Idempotent and resumable: an object that is already gone is a no-op; a row is marked only AFTER its object delete returned, so a
 * failure leaves the row pointing at the object and the next run retries it. A failure throws (the purge aborts with a P1, and the
 * tombstone, which nulls proof_url, has NOT run yet).
 */
export interface ProofFileDeps {
  d1All<T>(sql: string, ...params: unknown[]): Promise<T[]>;
  d1Run(sql: string, ...params: unknown[]): Promise<number>;
  deletePrivate(key: string): Promise<void>;
  deletePublic(key: string): Promise<void>;
  urlToKey(url: string): string | null;
  belongsToStore(key: string, storeId: string): boolean;
}

export async function deleteStoreProofFiles(
  storeId: string,
  deps: ProofFileDeps,
  now: number = Date.now()
): Promise<{ receipts: number; claims: number }> {
  let receipts = 0;
  let claims = 0;
  const rs = await deps.d1All<{ id: string; storage_key: string }>(
    `SELECT "id", "storage_key" FROM "instapay_receipts" WHERE "store_id" = ?1 AND "image_deleted_at" IS NULL ORDER BY "id"`,
    storeId
  );
  for (const r of rs) {
    await deps.deletePrivate(r.storage_key);
    await deps.d1Run(
      `UPDATE "instapay_receipts" SET "image_deleted_at" = ?2 WHERE "id" = ?1 AND "store_id" = ?3 AND "image_deleted_at" IS NULL`,
      r.id,
      now,
      storeId
    );
    receipts++;
  }
  const cs = await deps.d1All<{ id: string; proof_url: string }>(
    `SELECT "id", "proof_url" FROM "manual_payment_claims" WHERE "store_id" = ?1 AND "proof_url" IS NOT NULL ORDER BY "id"`,
    storeId
  );
  for (const c of cs) {
    const key = deps.urlToKey(c.proof_url);
    // only an object of THIS store is ever deleted; an external or foreign URL is simply unlinked
    if (key && deps.belongsToStore(key, storeId)) await deps.deletePublic(key);
    await deps.d1Run(
      `UPDATE "manual_payment_claims" SET "proof_url" = NULL WHERE "id" = ?1 AND "store_id" = ?2`,
      c.id,
      storeId
    );
    claims++;
  }
  return { receipts, claims };
}
