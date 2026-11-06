/**
 * Entity-index health alert (issue 458, Ruling NZ-MONEY-5). A StoreDO records its dead-lettered / abandoned entity-index rows as
 * one D1 `system_settings` row per store (cf/store-do/index-health.ts; a DO cannot call sendAlert). This hourly cron reads those
 * rows - ONE query, only stores with a problem have a row - and sends one P1 per row per day.
 *
 * Dedupe: `entity_index_alerted.<storeId>` holds `{ [outboxId]: lastAlertedAtMs }`; a row is alerted when never alerted or the last
 * alert is a day old, and an entry for a row that is no longer dead is dropped. An alert that is not 'sent' (throttled/failed) is
 * not recorded, so the next hourly tick retries it.
 * Cost if wrong: a D1 read failure skips one tick; the next one (an hour later) alerts.
 */
import { cfBindings } from '../cf/bindings';
import { INDEX_HEALTH_PREFIX, type IndexHealthValue } from '../cf/store-do/index-health';
import logger from './logger';
import { sendAlert } from '../services/alerts.service';

export const ALERTED_PREFIX = 'entity_index_alerted.';
const DAY_MS = 86_400_000;

interface D1Like {
  prepare(sql: string): {
    bind(...v: unknown[]): {
      all<T>(): Promise<{ results?: T[] }>;
      run(): Promise<unknown>;
    };
  };
}
type Send = typeof sendAlert;

export interface IndexHealthReport {
  stores: number;
  alerted: number;
}

export async function alertEntityIndexHealth(
  d1: D1Like,
  send: Send = sendAlert,
  now = Date.now()
): Promise<IndexHealthReport> {
  const out: IndexHealthReport = { stores: 0, alerted: 0 };
  const { results = [] } = await d1
    .prepare('SELECT key, value FROM system_settings WHERE key LIKE ?1 OR key LIKE ?2')
    .bind(`${INDEX_HEALTH_PREFIX}%`, `${ALERTED_PREFIX}%`)
    .all<{ key: string; value: string }>();
  const health = new Map<string, IndexHealthValue>();
  const alerted = new Map<string, Record<string, number>>();
  for (const r of results) {
    try {
      if (r.key.startsWith(INDEX_HEALTH_PREFIX))
        health.set(r.key.slice(INDEX_HEALTH_PREFIX.length), JSON.parse(r.value));
      else alerted.set(r.key.slice(ALERTED_PREFIX.length), JSON.parse(r.value));
    } catch {
      logger.warn({ key: r.key }, '[entity-index-health] unreadable settings row skipped');
    }
  }
  out.stores = health.size;

  for (const [storeId, h] of health) {
    const seen = alerted.get(storeId) ?? {};
    const next: Record<string, number> = {};
    for (const row of h.rows) {
      const last = seen[String(row.outboxId)];
      if (last !== undefined && now - last < DAY_MS) {
        next[String(row.outboxId)] = last;
        continue;
      }
      const outcome = await send({
        level: 'p1',
        source: 'api.entity_index_dead_letter',
        // unique per row: sendAlert throttles on (level, title) for 5 minutes, so two rows must not share a title
        title: `Entity index row ${row.abandoned ? 'ABANDONED' : 'dead-lettered'}: ${row.kind} ${row.id} (store ${storeId})`,
        body:
          `Store ${storeId}: ${row.kind} ${row.id} is not routable in D1 after ${row.attempts} attempts` +
          (row.abandoned
            ? ' and the background retry has stopped (14 days). Payments for it are refused until it is written: write it by hand or fix the row.'
            : ' (still retried hourly). Payments for it are refused until it is written.') +
          ` ${h.dead} dead-lettered row(s) in this store, ${h.abandoned} abandoned.`,
      });
      if (outcome === 'sent') {
        next[String(row.outboxId)] = now;
        out.alerted++;
      } else if (last !== undefined) next[String(row.outboxId)] = last;
    }
    if (JSON.stringify(next) !== JSON.stringify(seen))
      await d1
        .prepare(
          "INSERT INTO system_settings (id, key, value, category, is_public) VALUES (?1, ?2, ?3, 'ops', 0) ON CONFLICT (key) DO UPDATE SET value = excluded.value"
        )
        .bind(crypto.randomUUID(), `${ALERTED_PREFIX}${storeId}`, JSON.stringify(next))
        .run();
  }
  // a store whose health row is gone has recovered: forget its dedupe state
  for (const storeId of alerted.keys())
    if (!health.has(storeId))
      await d1
        .prepare('DELETE FROM system_settings WHERE key = ?1')
        .bind(`${ALERTED_PREFIX}${storeId}`)
        .run();
  return out;
}

/** The hourly cron job. No D1 binding (Node / local dev): nothing to read. */
export async function runEntityIndexHealthCron(): Promise<IndexHealthReport | null> {
  const d1 = (cfBindings() as { PLATFORM_DB?: D1Like } | undefined)?.PLATFORM_DB;
  if (!d1) return null;
  return alertEntityIndexHealth(d1);
}
