/**
 * User erasure on the D1 platform database: every column the erasure classification marks `scrub` with
 * subject key `userId` is set to NULL. Cloudflare twin of the Postgres scrubs (`AuthService.eraseAccount`:
 * `scrubProviderVerifier`; audit actor). `platform-erasure.test.ts` pins this list to
 * packages/cf-schema/erasure-classification.json, so a new classified column fails until it is handled here.
 */
import type { SyncSql } from './do/sync-sql';

/** table -> columns holding the erased user's id. */
export const PLATFORM_USER_SCRUB: Record<string, string[]> = {
  platform_audit_log: ['actor_id'],
  provider_verifications: ['verified_by_id'],
};

export function scrubUserFromPlatform(db: SyncSql, userId: string): { rows: number } {
  return db.transactionSync(() => {
    let rows = 0;
    for (const [table, columns] of Object.entries(PLATFORM_USER_SCRUB))
      for (const column of columns)
        rows += db.run(`UPDATE "${table}" SET "${column}" = NULL WHERE "${column}" = ?`, [
          userId,
        ]).changes;
    return { rows };
  });
}
