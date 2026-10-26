/**
 * User erasure of ACTOR ids (OFFBOARD-1): every column the erasure classification lists under `actorScrub` for a
 * database holds a user id on a row that survives the user (created_by, approved_by, actor_id, verified_by_id ...).
 * It is set to its replacement (NULL, or a tombstone for a NOT NULL column). The list is read from
 * packages/cf-schema/erasure-classification.json, so a newly classified column is handled with no code change
 * (and `platform-erasure.test.ts` fails if the classification and the schema disagree). Columns that belong to the
 * user (`subjectColumns`, their row goes) are the erasure engine's job; `retainedUserIds` are kept on purpose.
 * Postgres twin: `AuthService.eraseAccount` (scrubProviderVerifier and the audit actor scrubs).
 */
import classification from '../../cf-schema/erasure-classification.json';
import type { SyncSql } from './do/sync-sql';

type Entry = { db: 'store-do' | 'd1'; actorScrub?: Record<string, string | null> };
const ENTRIES = classification as unknown as Record<string, Entry>;

/** table -> { column: replacement } for one database. */
export function actorScrubPlan(
  db: 'store-do' | 'd1'
): Record<string, Record<string, string | null>> {
  const plan: Record<string, Record<string, string | null>> = {};
  for (const [key, e] of Object.entries(ENTRIES))
    if (e.db === db && e.actorScrub) plan[key.split(':')[1]] = e.actorScrub;
  return plan;
}

function run(sql: SyncSql, db: 'store-do' | 'd1', userId: string): { rows: number } {
  return sql.transactionSync(() => {
    let rows = 0;
    for (const [table, cols] of Object.entries(actorScrubPlan(db)))
      for (const [column, replacement] of Object.entries(cols))
        rows += sql.run(`UPDATE "${table}" SET "${column}" = ? WHERE "${column}" = ?`, [
          replacement,
          userId,
        ]).changes;
    return { rows };
  });
}

/** The D1 platform database. */
export const scrubUserFromPlatform = (sql: SyncSql, userId: string) => run(sql, 'd1', userId);
/** One store's Durable Object (call it on each store the user acted in). */
export const scrubUserFromStoreDo = (sql: SyncSql, userId: string) => run(sql, 'store-do', userId);
