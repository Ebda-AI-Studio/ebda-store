/**
 * Entity-index health alert (issue 458, Ruling NZ-MONEY-5). A StoreDO records its dead-lettered / abandoned entity-index rows as
 * one D1 `system_settings` row per store (cf/store-do/index-health.ts; a DO cannot call sendAlert). This hourly cron reads those
 * rows - ONE query, only stores with a problem have a row - and sends ONE aggregated P1 per run (rows due: never alerted or last alert a day old).
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
const D1_PARAM_LIMIT = 100;

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

  // A store POSITIVELY marked deleted (`deleted_at` set) can never be fixed: forget its health + dedupe rows instead of re-alerting
  // daily forever. A store merely MISSING from the D1 directory is NOT cleared: its dead rows still alert (that is a real problem).
  // Chunked to <= 100 bound params (D1 fails at 101). A read failure throws -> the tick skips and the next one retries.
  const ids = [...health.keys()];
  const deletedIds = new Set<string>();
  for (let i = 0; i < ids.length; i += D1_PARAM_LIMIT) {
    const chunk = ids.slice(i, i + D1_PARAM_LIMIT);
    const { results: delRows = [] } = await d1
      .prepare(
        `SELECT id FROM stores WHERE deleted_at IS NOT NULL AND id IN (${chunk.map((_, j) => `?${j + 1}`).join(',')})`
      )
      .bind(...chunk)
      .all<{ id: string }>();
    for (const r of delRows) deletedIds.add(r.id);
  }
  for (const storeId of ids)
    if (deletedIds.has(storeId)) {
      await d1
        .prepare('DELETE FROM system_settings WHERE key = ?1')
        .bind(`${INDEX_HEALTH_PREFIX}${storeId}`)
        .run();
      health.delete(storeId); // the dedupe row is dropped by the "health row is gone" loop below
    }
  out.stores = health.size;

  // ONE aggregated P1 per run: N dead rows across M stores must never be N pages.
  const due: { storeId: string; outboxId: string }[] = [];
  const keep = new Map<string, Record<string, number>>();
  let abandoned = 0;
  const sample: string[] = [];
  for (const [storeId, h] of health) {
    const seen = alerted.get(storeId) ?? {};
    const next: Record<string, number> = {};
    keep.set(storeId, next);
    for (const row of h.rows) {
      const last = seen[String(row.outboxId)];
      if (last !== undefined && now - last < DAY_MS) {
        next[String(row.outboxId)] = last;
        continue;
      }
      due.push({ storeId, outboxId: String(row.outboxId) });
      if (row.abandoned) abandoned++;
      if (sample.length < 5) sample.push(`${storeId}:${row.kind}:${row.id}`);
      if (last !== undefined) next[String(row.outboxId)] = last;
    }
  }
  if (due.length) {
    const storeCount = new Set(due.map(d => d.storeId)).size;
    const outcome = await send({
      level: 'p1',
      source: 'api.entity_index_dead_letter',
      title: `Entity index: ${due.length} row(s) not routable in ${storeCount} store(s)`,
      body:
        `${due.length} entity-index row(s) in ${storeCount} store(s) are not routable in D1 (${abandoned} abandoned, retry stopped after 14 days; ` +
        `the rest are dead-lettered and still retried hourly). Payments for them are refused until they are written. ` +
        `Sample (store:kind:id): ${sample.join(', ')}.`,
    });
    if (outcome === 'sent') for (const d of due) keep.get(d.storeId)![d.outboxId] = now;
    out.alerted = outcome === 'sent' ? due.length : 0;
  }
  for (const [storeId, next] of keep) {
    const seen = alerted.get(storeId) ?? {};
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
