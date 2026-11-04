// Per-store analytics on the StoreDO (Ruling NZ-AN-1): the five tables that used to be Postgres "analytics" targets
// (search_query_daily, product_daily_views, qr_scan_daily, notification_logs, gsc_daily_metrics) live in the store's own DO.
// Each op is scoped by the `store_id` the DO holds, never by the caller, and runs as ONE section (runKeyed wraps it).
//
// Counters are the same statements the Postgres services ran (a counter, not an event log) with SQLite spelling.
// `dayMs` is the UTC-midnight epoch of the calendar day (what a Postgres `date` column holds as a Date).
import { MoneyError, type SyncSql } from './sync-sql';

const INT4_CAP = 2147483646;
const DAY_MS = 86_400_000;

const intArg = (v: unknown, what: string, min: number, max: number): number => {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max)
    throw new MoneyError('BAD_ARGS', what, 400);
  return v;
};
const strArg = (v: unknown, what: string, max: number, allowEmpty = false): string => {
  if (typeof v !== 'string' || v.length > max || (!allowEmpty && v.length === 0))
    throw new MoneyError('BAD_ARGS', what, 400);
  return v;
};
const dayArg = (v: unknown, what: string): number => {
  const n = intArg(v, what, 0, Number.MAX_SAFE_INTEGER);
  if (n % DAY_MS !== 0) throw new MoneyError('BAD_ARGS', `${what} must be a UTC midnight`, 400);
  return n;
};

/** One storefront search counted. `counted` is false when the day's term cap is full (a NEW term is dropped, an existing one still counts). */
export function searchLogRecordOp(
  db: SyncSql,
  storeId: string,
  a: Record<string, unknown>
): { counted: boolean } {
  const day = dayArg(a.dayMs, 'dayMs');
  const term = strArg(a.term, 'term', 100);
  const count = intArg(a.count, 'count', 0, INT4_CAP);
  const zero = intArg(a.zero, 'zero', 0, 1);
  const cap = intArg(a.cap, 'cap', 1, 1_000_000);
  const r = db.run(
    `INSERT INTO search_query_daily (id, store_id, date, term, searches, zero_results, last_result_count, updated_at)
     SELECT ?1, ?2, ?3, ?4, 1, ?5, ?6, ?3
      WHERE EXISTS (SELECT 1 FROM search_query_daily WHERE store_id = ?2 AND date = ?3 AND term = ?4)
         OR (SELECT count(*) FROM search_query_daily WHERE store_id = ?2 AND date = ?3) < ?7
     ON CONFLICT (store_id, date, term) DO UPDATE SET
       searches = MIN(search_query_daily.searches, ${INT4_CAP}) + 1,
       zero_results = MIN(search_query_daily.zero_results, ${INT4_CAP}) + excluded.zero_results,
       last_result_count = excluded.last_result_count,
       updated_at = excluded.updated_at`,
    [crypto.randomUUID(), storeId, day, term, zero, count, cap]
  );
  return { counted: r.changes > 0 };
}

/** Retention: delete this store's search rows dated before `cutoffMs`. */
export function searchLogPurgeOp(
  db: SyncSql,
  storeId: string,
  a: Record<string, unknown>
): { deleted: number } {
  const cutoff = dayArg(a.cutoffMs, 'cutoffMs');
  return {
    deleted: db.run('DELETE FROM search_query_daily WHERE store_id = ? AND date < ?', [
      storeId,
      cutoff,
    ]).changes,
  };
}

export interface SearchInsightsResult {
  totals: { searches: number; zero: number };
  terms: Array<{ term: string; searches: number; zero_results: number; last_result_count: number }>;
}

/** The admin search-insights read: window totals plus the top terms (privacy floor `minShown` applies to terms only). */
export function searchInsightsOp(
  db: SyncSql,
  storeId: string,
  a: Record<string, unknown>
): SearchInsightsResult {
  const since = dayArg(a.sinceMs, 'sinceMs');
  const minShown = intArg(a.minShown, 'minShown', 1, 1_000_000);
  const zeroOnly = a.zeroOnly === true;
  const limit = intArg(a.limit ?? 50, 'limit', 1, 200);
  const t = db.all(
    `SELECT COALESCE(SUM(searches), 0) AS searches, COALESCE(SUM(zero_results), 0) AS zero
       FROM search_query_daily WHERE store_id = ? AND date >= ?`,
    [storeId, since]
  )[0] as Record<string, unknown>;
  const rows = db.all(
    `SELECT s.term AS term, SUM(s.searches) AS searches, SUM(s.zero_results) AS zero_results,
            (SELECT l.last_result_count FROM search_query_daily l
              WHERE l.store_id = ?1 AND l.term = s.term AND l.date >= ?2 ORDER BY l.date DESC LIMIT 1) AS last_result_count
       FROM search_query_daily s
      WHERE s.store_id = ?1 AND s.date >= ?2
      GROUP BY s.term
     HAVING SUM(s.searches) >= ?3 AND (?4 = 0 OR SUM(s.zero_results) > 0)
      ORDER BY CASE WHEN ?4 = 1 THEN SUM(s.zero_results) ELSE SUM(s.searches) END DESC, SUM(s.searches) DESC, s.term ASC
      LIMIT ?5`,
    [storeId, since, minShown, zeroOnly ? 1 : 0, limit]
  );
  return {
    totals: { searches: Number(t.searches ?? 0), zero: Number(t.zero ?? 0) },
    terms: rows.map(r => ({
      term: String(r.term),
      searches: Number(r.searches),
      zero_results: Number(r.zero_results),
      last_result_count: Number(r.last_result_count ?? 0),
    })),
  };
}

/** One QR scan counted; `pruneBeforeMs` (optional) also drops this store's rows older than it, in the same section. */
export function qrScanRecordOp(
  db: SyncSql,
  storeId: string,
  a: Record<string, unknown>
): { counted: true } {
  const day = dayArg(a.dayMs, 'dayMs');
  const kind = strArg(a.kind, 'kind', 12);
  const ref = strArg(a.ref, 'ref', 64, true);
  db.run(
    `INSERT INTO qr_scan_daily (id, store_id, date, kind, ref, count) VALUES (?1, ?2, ?3, ?4, ?5, 1)
     ON CONFLICT (store_id, date, kind, ref) DO UPDATE SET count = MIN(qr_scan_daily.count, ${INT4_CAP}) + 1`,
    [crypto.randomUUID(), storeId, day, kind, ref]
  );
  if (a.pruneBeforeMs !== undefined) {
    const cutoff = dayArg(a.pruneBeforeMs, 'pruneBeforeMs');
    db.run('DELETE FROM qr_scan_daily WHERE store_id = ? AND date < ?', [storeId, cutoff]);
  }
  return { counted: true };
}

/** One product view counted for the day. The product must exist in this store (foreign key); otherwise the op throws and the caller fails open. */
export function viewRecordOp(
  db: SyncSql,
  storeId: string,
  a: Record<string, unknown>
): { counted: true } {
  const day = dayArg(a.dayMs, 'dayMs');
  const productId = strArg(a.productId, 'productId', 128);
  const owns = db.all('SELECT 1 AS n FROM products WHERE id = ? AND store_id = ?', [
    productId,
    storeId,
  ])[0];
  if (!owns) throw new MoneyError('NOT_FOUND', 'product not found', 404);
  db.run(
    `INSERT INTO product_daily_views (id, store_id, product_id, date, count) VALUES (?1, ?2, ?3, ?4, 1)
     ON CONFLICT (store_id, product_id, date) DO UPDATE SET count = MIN(product_daily_views.count, ${INT4_CAP}) + 1`,
    [crypto.randomUUID(), storeId, productId, day]
  );
  return { counted: true };
}

// ---------------------------------------------------------------------------------------------------------------------
// Copy of the existing Postgres rows (scripts/cf/copy-analytics-to-do.mjs, run by the controller)
// ---------------------------------------------------------------------------------------------------------------------

/** table -> its columns (the copy writes exactly these; anything else is refused) and the columns whose SUM is verified. */
export const ANALYTICS_TABLES: Readonly<
  Record<
    string,
    { columns: readonly string[]; sums: readonly string[]; extremes?: readonly string[] }
  >
> = {
  search_query_daily: {
    columns: [
      'id',
      'store_id',
      'date',
      'term',
      'searches',
      'zero_results',
      'last_result_count',
      'updated_at',
    ],
    sums: ['searches', 'zero_results', 'last_result_count'],
  },
  product_daily_views: {
    columns: ['id', 'store_id', 'product_id', 'date', 'count'],
    sums: ['count'],
  },
  qr_scan_daily: { columns: ['id', 'store_id', 'date', 'kind', 'ref', 'count'], sums: ['count'] },
  notification_logs: {
    columns: [
      'id',
      'store_id',
      'channel',
      'event',
      'recipient_phone_hash',
      'recipient_email_hash',
      'status',
      'provider_message_id',
      'idempotency_key',
      'error',
      'metadata',
      'created_at',
      'updated_at',
    ],
    // no SUM of epoch-ms (it passes 2^53 after ~5k rows and JS and SQLite then round differently): count + MIN/MAX instead
    sums: [],
    extremes: ['created_at', 'updated_at'],
  },
  gsc_daily_metrics: {
    columns: [
      'id',
      'store_id',
      'date',
      'impressions',
      'clicks',
      'ctr',
      'avg_position',
      'top_queries',
      'created_at',
      'updated_at',
    ],
    sums: ['impressions', 'clicks'],
  },
};

const LEDGER = '_analytics_import';
const DONE = '__done__';
const ensureLedger = (db: SyncSql): void => {
  db.run(
    `CREATE TABLE IF NOT EXISTS ${LEDGER} (batch_id TEXT PRIMARY KEY, tbl TEXT NOT NULL, row_count INTEGER NOT NULL, at INTEGER NOT NULL)`,
    []
  );
};
const isDone = (db: SyncSql): boolean =>
  db.all(`SELECT 1 AS n FROM ${LEDGER} WHERE batch_id = ?`, [DONE]).length > 0;

function totalsFor(
  db: SyncSql,
  storeId: string,
  tbl: string
): { rows: number; sums: Record<string, number> } {
  const spec = ANALYTICS_TABLES[tbl];
  const ext = spec.extremes ?? [];
  const cols = [
    'COUNT(*) AS n',
    ...spec.sums.map(c => `COALESCE(SUM("${c}"), 0) AS "s_${c}"`),
    ...ext.flatMap(c => [
      `COALESCE(MIN("${c}"), 0) AS "min_${c}"`,
      `COALESCE(MAX("${c}"), 0) AS "max_${c}"`,
    ]),
  ];
  const r = db.all(`SELECT ${cols.join(', ')} FROM "${tbl}" WHERE store_id = ?`, [storeId])[0] as
    | Record<string, unknown>
    | undefined;
  return {
    rows: Number(r?.n ?? 0),
    sums: {
      ...Object.fromEntries(spec.sums.map(c => [c, Number(r?.[`s_${c}`] ?? 0)])),
      ...Object.fromEntries(
        ext.flatMap(c => [
          [`min:${c}`, Number(r?.[`min_${c}`] ?? 0)],
          [`max:${c}`, Number(r?.[`max_${c}`] ?? 0)],
        ])
      ),
    },
  };
}

/** What the copy needs before it starts: whether it already finished, the batches applied and each table's current totals. */
export function analyticsImportStatusOp(
  db: SyncSql,
  storeId: string
): {
  done: boolean;
  batches: number;
  tables: Record<string, { rows: number; sums: Record<string, number> }>;
} {
  ensureLedger(db);
  return {
    done: isDone(db),
    batches: Number(
      (
        db.all(`SELECT COUNT(*) AS n FROM ${LEDGER} WHERE batch_id <> ?`, [DONE])[0] as Record<
          string,
          unknown
        >
      ).n
    ),
    tables: Object.fromEntries(
      Object.keys(ANALYTICS_TABLES).map(t => [t, totalsFor(db, storeId, t)])
    ),
  };
}

/**
 * Apply one batch of Postgres rows. Refused after the finish marker. A batch id that was already applied is a no-op
 * (`replayed`), so an interrupted run is simply re-run: PostgreSQL is frozen for this store while it runs, so the batches
 * (ordered by primary key, fixed size) are the same every time. The first batch refuses a DO that already holds analytics rows
 * (native rows would make the totals unverifiable and could double count).
 */
export function analyticsImportOp(
  db: SyncSql,
  storeId: string,
  a: Record<string, unknown>
): { applied: number; replayed: boolean } {
  ensureLedger(db);
  if (isDone(db)) throw new MoneyError('ANALYTICS_IMPORT_CLOSED', 'the copy already finished', 409);
  const batchId = strArg(a.batchId, 'batchId', 160);
  const tbl = strArg(a.table, 'table', 64);
  const spec = Object.prototype.hasOwnProperty.call(ANALYTICS_TABLES, tbl)
    ? ANALYTICS_TABLES[tbl]
    : undefined;
  if (!spec) throw new MoneyError('BAD_ARGS', 'table', 400);
  if (!Array.isArray(a.rows) || a.rows.length === 0 || a.rows.length > 500)
    throw new MoneyError('BAD_ARGS', 'rows', 400);
  if (db.all(`SELECT 1 AS n FROM ${LEDGER} WHERE batch_id = ?`, [batchId]).length)
    return { applied: 0, replayed: true };
  const first = db.all(`SELECT COUNT(*) AS n FROM ${LEDGER}`, [])[0] as Record<string, unknown>;
  if (Number(first.n) === 0)
    for (const t of Object.keys(ANALYTICS_TABLES))
      if (totalsFor(db, storeId, t).rows > 0)
        throw new MoneyError(
          'ANALYTICS_IMPORT_NOT_EMPTY',
          `${t} already holds rows in this DO; refusing to copy over them`,
          409
        );
  const cols = spec.columns;
  const sql = `INSERT INTO "${tbl}" (${cols.map(c => `"${c}"`).join(', ')}) VALUES (${cols.map((_, i) => `?${i + 1}`).join(', ')})`;
  for (const row of a.rows as Array<Record<string, unknown>>) {
    if (!row || typeof row !== 'object' || row.store_id !== storeId)
      throw new MoneyError('BAD_ARGS', 'row store_id', 400);
    db.run(
      sql,
      cols.map(c => {
        const v = row[c];
        if (v === undefined) throw new MoneyError('BAD_ARGS', `row.${c}`, 400);
        return v;
      })
    );
  }
  db.run(`INSERT INTO ${LEDGER} (batch_id, tbl, row_count, at) VALUES (?, ?, ?, ?)`, [
    batchId,
    tbl,
    (a.rows as unknown[]).length,
    Date.now(),
  ]);
  return { applied: (a.rows as unknown[]).length, replayed: false };
}

/**
 * Close the copy: compare every table's totals (row count + the SUM of its counter columns) with what Postgres held, and
 * only on an exact match write the marker (after which every batch is refused). Idempotent once done.
 */
export function analyticsImportFinishOp(
  db: SyncSql,
  storeId: string,
  a: Record<string, unknown>
): { done: true; tables: Record<string, number> } {
  ensureLedger(db);
  const expect = a.expect as Record<string, { rows: number; sums: Record<string, number> }>;
  if (!expect || typeof expect !== 'object') throw new MoneyError('BAD_ARGS', 'expect', 400);
  const ledgerRows: Record<string, number> = {};
  for (const r of db.all(
    `SELECT tbl, SUM(row_count) AS n FROM ${LEDGER} WHERE batch_id <> ? GROUP BY tbl`,
    [DONE]
  ))
    ledgerRows[String(r.tbl)] = Number(r.n);
  const out: Record<string, number> = {};
  for (const tbl of Object.keys(ANALYTICS_TABLES)) {
    const have = totalsFor(db, storeId, tbl);
    const want = expect[tbl];
    if (!want) throw new MoneyError('BAD_ARGS', `expect.${tbl}`, 400);
    if (have.rows !== want.rows || (ledgerRows[tbl] ?? 0) !== want.rows)
      throw new MoneyError(
        'ANALYTICS_IMPORT_MISMATCH',
        `${tbl}: rows ${have.rows} (ledger ${ledgerRows[tbl] ?? 0}) != ${want.rows}`,
        409
      );
    for (const c of Object.keys(have.sums))
      if (have.sums[c] !== want.sums?.[c])
        throw new MoneyError(
          'ANALYTICS_IMPORT_MISMATCH',
          `${tbl}.${c}: ${have.sums[c]} != ${want.sums?.[c]}`,
          409
        );
    out[tbl] = have.rows;
  }
  if (!isDone(db))
    db.run(`INSERT INTO ${LEDGER} (batch_id, tbl, row_count, at) VALUES (?, ?, 0, ?)`, [
      DONE,
      DONE,
      Date.now(),
    ]);
  return { done: true, tables: out };
}

/**
 * Wipe this store's five analytics tables and the copy ledger (including the done-marker) so the copy can start from a clean
 * slate. PRE-MARKER ONLY: before the D1 marker the DO's analytics tables hold nothing but copied rows (the API writes them to
 * Postgres until then), so nothing native is lost. The refusal after the marker is enforced where the D1 binding is: the
 * `__analytics` cutover route (apps/api/src/cf/cutover.ts) reads the marker and answers 409 before this op can run.
 * `confirm` must equal the store id.
 */
export function analyticsImportResetOp(
  db: SyncSql,
  storeId: string,
  a: Record<string, unknown>
): { reset: true; deleted: Record<string, number> } {
  if (a.confirm !== storeId) throw new MoneyError('BAD_ARGS', 'confirm must be the store id', 400);
  ensureLedger(db);
  const deleted: Record<string, number> = {};
  for (const tbl of Object.keys(ANALYTICS_TABLES))
    deleted[tbl] = db.run(`DELETE FROM "${tbl}" WHERE store_id = ?`, [storeId]).changes;
  db.run(`DELETE FROM ${LEDGER}`, []);
  return { reset: true, deleted };
}
