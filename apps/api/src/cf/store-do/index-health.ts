/**
 * Entity-index health (issue 458, Ruling NZ-MONEY-5). A StoreDO cannot call `sendAlert` (no Redis, no Telegram secrets), so it
 * RECORDS its dead-lettered / abandoned entity-index rows as ONE D1 `system_settings` row per store; the API Worker's hourly
 * cron (lib/entity-index-health.ts) reads those rows with a single query - only stores with a problem have one - and alerts.
 *
 * The row exists exactly while the store has dead-lettered rows: written when the set changes, deleted when it clears.
 * Staleness class: BOUNDED-stale (one alarm); a stale row costs at most one extra daily alert for a row already written.
 */

/** Structural twin of `deadLetterReport()` in packages/repo (the DO bundle types the repo module through cf/repo-modules.d.ts). */
export interface DeadLetterReport {
  dead: number;
  abandoned: number;
  rows: Array<{
    outboxId: number;
    kind: string;
    id: string;
    storeId: string;
    attempts: number;
    abandoned: boolean;
  }>;
}

export const INDEX_HEALTH_PREFIX = 'entity_index_health.';
export const indexHealthKey = (storeId: string): string => `${INDEX_HEALTH_PREFIX}${storeId}`;

export interface IndexHealthValue {
  storeId: string;
  dead: number;
  abandoned: number;
  /** the oldest 20 dead-lettered rows */
  rows: DeadLetterReport['rows'];
  updatedAt: number;
}

interface D1Like {
  prepare(sql: string): { bind(...v: unknown[]): { run(): Promise<unknown> } };
}

/**
 * Upsert (report has rows) or delete (report empty, a row was published) the store's health row. `lastSig` is the signature of
 * what is published now (null = nothing published); returns the new one. No D1 call when nothing changed. Never throws.
 */
export async function publishIndexHealth(
  d1: D1Like,
  storeId: string,
  report: DeadLetterReport,
  lastSig: string | null,
  now = Date.now()
): Promise<string | null> {
  const sig =
    report.dead === 0
      ? null
      : JSON.stringify([report.dead, report.abandoned, report.rows.map(r => r.outboxId)]);
  if (sig === lastSig) return lastSig;
  try {
    if (sig === null) {
      await d1
        .prepare('DELETE FROM system_settings WHERE key = ?1')
        .bind(indexHealthKey(storeId))
        .run();
    } else {
      const value: IndexHealthValue = {
        storeId,
        dead: report.dead,
        abandoned: report.abandoned,
        rows: report.rows,
        updatedAt: now,
      };
      await d1
        .prepare(
          "INSERT INTO system_settings (id, key, value, category, is_public) VALUES (?1, ?2, ?3, 'ops', 0) ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = ?4"
        )
        .bind(crypto.randomUUID(), indexHealthKey(storeId), JSON.stringify(value), now)
        .run();
    }
    return sig;
  } catch (err) {
    console.error('[P1] entity index health not published', err);
    return lastSig; // retried on the next drain
  }
}
