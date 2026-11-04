// Ruling NZ-AN-1: per-store analytics counters, reads and the Postgres copy, on the real DO schema (node:sqlite).
import { describe, expect, it } from 'vitest';
import { openSqlite } from './diff-harness';
import { nodeSyncSql } from './node-sync-sql';
import { ensureMoneyOpsSchema, MONEY_OP_NAMES, runMoneyOp } from '../src/do/money-ops';

const DAY = 86_400_000;
const D0 = Date.UTC(2026, 9, 1);

function rig() {
  const raw = openSqlite();
  const db = nodeSyncSql(raw);
  ensureMoneyOpsSchema(db);
  raw.exec(
    `INSERT INTO products (id, store_id, name, slug, price, inventory, status) VALUES ('p1', 's1', 'W', 'w', 1000, 20, 'active');`
  );
  const op = (name: string, args: Record<string, unknown>, store = 's1') =>
    runMoneyOp(db, store, name, args) as any;
  return { raw, op };
}
const all = (raw: ReturnType<typeof openSqlite>, sql: string) => raw.prepare(sql).all() as any[];

describe('registration', () => {
  it.each([
    'searchLogRecord',
    'searchLogPurge',
    'searchInsights',
    'qrScanRecord',
    'viewRecord',
    'analyticsImportStatus',
    'analyticsImport',
    'analyticsImportFinish',
  ])('%s is a money op', n => expect(MONEY_OP_NAMES).toContain(n));
});

describe('searchLogRecord', () => {
  it('counts a term once per search, tracks zero results and the last result count', () => {
    const { raw, op } = rig();
    expect(op('searchLogRecord', { dayMs: D0, term: 'shoes', count: 0, zero: 1, cap: 5 })).toEqual({
      counted: true,
    });
    op('searchLogRecord', { dayMs: D0, term: 'shoes', count: 7, zero: 0, cap: 5 });
    const rows = all(raw, 'SELECT * FROM search_query_daily');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ searches: 2, zero_results: 1, last_result_count: 7, date: D0 });
  });

  it('the daily cap drops a NEW term but still counts an existing one', () => {
    const { raw, op } = rig();
    for (const t of ['a', 'b'])
      op('searchLogRecord', { dayMs: D0, term: t, count: 1, zero: 0, cap: 2 });
    expect(op('searchLogRecord', { dayMs: D0, term: 'c', count: 1, zero: 0, cap: 2 })).toEqual({
      counted: false,
    });
    expect(op('searchLogRecord', { dayMs: D0, term: 'a', count: 1, zero: 0, cap: 2 })).toEqual({
      counted: true,
    });
    expect(all(raw, 'SELECT term, searches FROM search_query_daily ORDER BY term')).toEqual([
      { term: 'a', searches: 2 },
      { term: 'b', searches: 1 },
    ]);
  });

  it('rejects a non-midnight day and a bad term', () => {
    const { op } = rig();
    expect(() =>
      op('searchLogRecord', { dayMs: D0 + 5, term: 'x', count: 1, zero: 0, cap: 2 })
    ).toThrow();
    expect(() =>
      op('searchLogRecord', { dayMs: D0, term: '', count: 1, zero: 0, cap: 2 })
    ).toThrow();
  });

  it('purge deletes only rows before the cutoff', () => {
    const { raw, op } = rig();
    op('searchLogRecord', { dayMs: D0 - 100 * DAY, term: 'old', count: 1, zero: 0, cap: 9 });
    op('searchLogRecord', { dayMs: D0, term: 'new', count: 1, zero: 0, cap: 9 });
    expect(op('searchLogPurge', { cutoffMs: D0 - 90 * DAY })).toEqual({ deleted: 1 });
    expect(all(raw, 'SELECT term FROM search_query_daily')).toEqual([{ term: 'new' }]);
  });
});

describe('searchInsights', () => {
  it('applies the privacy floor to terms only, orders by zero results when asked, keeps the last count', () => {
    const { op } = rig();
    for (let i = 0; i < 3; i++)
      op('searchLogRecord', { dayMs: D0 - DAY, term: 'rare', count: 0, zero: 1, cap: 9 });
    op('searchLogRecord', { dayMs: D0, term: 'rare', count: 4, zero: 0, cap: 9 });
    for (let i = 0; i < 5; i++)
      op('searchLogRecord', { dayMs: D0, term: 'popular', count: 9, zero: 0, cap: 9 });
    op('searchLogRecord', { dayMs: D0, term: 'once', count: 0, zero: 1, cap: 9 });
    const r = op('searchInsights', { sinceMs: D0 - 2 * DAY, minShown: 3, zeroOnly: false });
    expect(r.totals).toEqual({ searches: 10, zero: 4 });
    expect(r.terms.map((t: any) => t.term)).toEqual(['popular', 'rare']);
    expect(r.terms[1]).toMatchObject({ searches: 4, zero_results: 3, last_result_count: 4 });
    const z = op('searchInsights', { sinceMs: D0 - 2 * DAY, minShown: 3, zeroOnly: true });
    expect(z.terms.map((t: any) => t.term)).toEqual(['rare']);
  });
});

describe('qrScanRecord and viewRecord', () => {
  it('count per day, prune only on request, and a view needs a product of this store', () => {
    const { raw, op } = rig();
    op('qrScanRecord', { dayMs: D0 - 500 * DAY, kind: 'product', ref: 'p1' });
    op('qrScanRecord', { dayMs: D0, kind: 'product', ref: 'p1' });
    op('qrScanRecord', { dayMs: D0, kind: 'product', ref: 'p1', pruneBeforeMs: D0 - 400 * DAY });
    expect(all(raw, 'SELECT date, count FROM qr_scan_daily')).toEqual([{ date: D0, count: 2 }]);
    op('viewRecord', { dayMs: D0, productId: 'p1' });
    op('viewRecord', { dayMs: D0, productId: 'p1' });
    expect(all(raw, 'SELECT count FROM product_daily_views')).toEqual([{ count: 2 }]);
    expect(() => op('viewRecord', { dayMs: D0, productId: 'p1' }, 's2')).toThrow();
    expect(() => op('viewRecord', { dayMs: D0, productId: 'nope' })).toThrow();
  });
});

describe('the Postgres copy', () => {
  const row = (t: string, i: number) =>
    t === 'search_query_daily'
      ? {
          id: `q${i}`,
          store_id: 's1',
          date: D0,
          term: `t${i}`,
          searches: 3,
          zero_results: 1,
          last_result_count: 2,
          updated_at: D0,
        }
      : t === 'product_daily_views'
        ? { id: `v${i}`, store_id: 's1', product_id: 'p1', date: D0 + i * DAY, count: 4 }
        : t === 'qr_scan_daily'
          ? { id: `r${i}`, store_id: 's1', date: D0, kind: 'product', ref: `x${i}`, count: 5 }
          : t === 'notification_logs'
            ? {
                id: `n${i}`,
                store_id: 's1',
                channel: 'sms',
                event: 'e',
                recipient_phone_hash: null,
                recipient_email_hash: null,
                status: 'sent',
                provider_message_id: null,
                idempotency_key: `k${i}`,
                error: null,
                metadata: '{}',
                created_at: D0,
                updated_at: D0,
              }
            : {
                id: `g${i}`,
                store_id: 's1',
                date: D0 + i * DAY,
                impressions: 10,
                clicks: 2,
                ctr: 0.2,
                avg_position: 3.5,
                top_queries: '[]',
                created_at: D0,
                updated_at: D0,
              };
  const TABLES = [
    'search_query_daily',
    'product_daily_views',
    'qr_scan_daily',
    'notification_logs',
    'gsc_daily_metrics',
  ];
  const expectAll = {
    search_query_daily: { rows: 2, sums: { searches: 6, zero_results: 2, last_result_count: 4 } },
    product_daily_views: { rows: 2, sums: { count: 8 } },
    qr_scan_daily: { rows: 2, sums: { count: 10 } },
    notification_logs: { rows: 2, sums: { created_at: 2 * D0 } },
    gsc_daily_metrics: { rows: 2, sums: { impressions: 20, clicks: 4 } },
  };
  const load = (op: ReturnType<typeof rig>['op']) =>
    TABLES.forEach(t =>
      op('analyticsImport', { batchId: `b:${t}:0`, table: t, rows: [row(t, 0), row(t, 1)] })
    );

  it('applies a batch once (a replayed batch id is a no-op) and finishes only on exact totals', () => {
    const { raw, op } = rig();
    load(op);
    expect(
      op('analyticsImport', {
        batchId: 'b:qr_scan_daily:0',
        table: 'qr_scan_daily',
        rows: [row('qr_scan_daily', 0)],
      })
    ).toEqual({
      applied: 0,
      replayed: true,
    });
    expect(all(raw, 'SELECT COUNT(*) AS n FROM qr_scan_daily')[0].n).toBe(2);
    const bad = { ...expectAll, qr_scan_daily: { rows: 2, sums: { count: 11 } } };
    expect(() => op('analyticsImportFinish', { expect: bad })).toThrow(
      /ANALYTICS_IMPORT|qr_scan_daily/
    );
    expect(op('analyticsImportStatus', {}).done).toBe(false);
    expect(op('analyticsImportFinish', { expect: expectAll })).toMatchObject({ done: true });
    expect(op('analyticsImportStatus', {}).done).toBe(true);
  });

  it('refuses every batch after the marker, and a DO that already holds native rows', () => {
    const { op } = rig();
    load(op);
    op('analyticsImportFinish', { expect: expectAll });
    expect(() =>
      op('analyticsImport', {
        batchId: 'late',
        table: 'qr_scan_daily',
        rows: [row('qr_scan_daily', 9)],
      })
    ).toThrow(/copy already finished/);
    const fresh = rig();
    fresh.op('qrScanRecord', { dayMs: D0, kind: 'product', ref: 'z' });
    expect(() =>
      fresh.op('analyticsImport', {
        batchId: 'b',
        table: 'qr_scan_daily',
        rows: [row('qr_scan_daily', 0)],
      })
    ).toThrow(/already holds rows/);
  });

  it('refuses a row of another store, an unknown table and a missing column', () => {
    const { op } = rig();
    expect(() =>
      op('analyticsImport', {
        batchId: 'x1',
        table: 'qr_scan_daily',
        rows: [{ ...row('qr_scan_daily', 0), store_id: 's2' }],
      })
    ).toThrow();
    expect(() => op('analyticsImport', { batchId: 'x2', table: 'orders', rows: [{}] })).toThrow();
    const { count: _c, ...short } = row('qr_scan_daily', 0) as any;
    expect(() =>
      op('analyticsImport', { batchId: 'x3', table: 'qr_scan_daily', rows: [short] })
    ).toThrow();
  });
});
