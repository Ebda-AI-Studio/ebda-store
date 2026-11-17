/**
 * Ruling ANALYTICS-DAY-1: view and QR counters on a DO store are written under the SAME day key the funnel rollup and QR
 * stats read. This test uses the REAL DO ops (runMoneyOp on the real StoreDO schema, node:sqlite) and the REAL prisma-lite
 * reader - the money client is NOT a Proxy that accepts anything (the old analytics-on-do.test.ts was, and missed D1: both
 * ops threw BAD_ARGS for any real Cairo day because the callers passed the Cairo midnight instant, not a UTC-midnight key).
 *
 * The key: UTC midnight of the UTC date of the Cairo day-start instant (what the Postgres `date` column held, so copied
 * history joins). Cairo midnight is 22:00Z (winter) / 21:00Z (summer) of the PREVIOUS UTC date, so the key of Cairo day D
 * is the UTC midnight of D-1. Expected values below are hard-coded on purpose.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openSqlite, insertSqlite, META } from '../../packages/repo/test/diff-harness';
import { nodeSyncSql } from '../../packages/repo/test/node-sync-sql';
import { nodeSqlRunner } from '../../packages/repo/test/node-sql';
import { createPrismaLite } from '../../packages/repo/src/prisma-lite/client';
import { ensureMoneyOpsSchema, runMoneyOp } from '../../packages/repo/src/do/money-ops';

const STORE = '09b5dbd1-1774-49b5-b781-e06d0ee7b0fe';
const h = vi.hoisted(() => ({
  raw: null as unknown,
  lite: null as unknown,
  sync: null as unknown,
  failMoney: false,
  captured: [] as unknown[],
  funnelRows: [] as Array<Record<string, number | Date>>,
}));

vi.mock('@ebda/database', async () =>
  (await import('./helpers/database-mock')).databaseMock({
    prisma: new Proxy(
      {},
      {
        get: (_t, p) => {
          throw new Error(`Postgres touched: ${String(p)}`);
        },
      }
    ),
    extra: {
      withStore: async () => {
        throw new Error('Postgres touched: withStore');
      },
    },
  })
);
vi.mock('@api/lib/analytics-backend', () => ({
  analyticsMoney: async () => {
    if (h.failMoney) throw new Error('DO unreachable');
    return new Proxy(
      {},
      {
        get: (_t, op: string) =>
          op === 'then'
            ? undefined
            : async (a: Record<string, unknown>) => runMoneyOp(h.sync as never, STORE, op, a),
      }
    );
  },
  analyticsOnDo: async () => true,
  analyticsRead: async (_id: string, onDo: (r: unknown) => unknown) => onDo(h.lite),
}));
vi.mock('@api/lib/repo-factory', () => ({
  storeDb: async () => h.lite,
  storeWriter: async () => ({
    funnelSnapshot: {
      createMany: async ({ data }: { data: Array<Record<string, number | Date>> }) => {
        h.funnelRows.push(...data);
      },
      update: async () => ({}),
    },
  }),
}));
vi.mock('@api/lib/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('@api/lib/savepoint', () => ({ withSavepoint: async (fn: () => unknown) => fn() }));
vi.mock('@api/services/sentry.service', () => ({
  SentryService: {
    captureException: (e: unknown, ctx: unknown) => {
      h.captured.push([e, ctx]);
      return '';
    },
  },
}));

import { recordProductView } from '@api/services/view-ingest.service';
import { recordQrScan, qrStats } from '@api/services/qr.service';
import { runFunnelRollup } from '@api/services/accounting/analytics-rollup.service';

type Raw = ReturnType<typeof openSqlite>;
const rows = (sql: string) => (h.raw as Raw).prepare(sql).all() as Array<Record<string, number>>;

beforeEach(() => {
  const raw = openSqlite();
  h.raw = raw;
  h.sync = nodeSyncSql(raw);
  ensureMoneyOpsSchema(h.sync as never);
  raw.exec(
    `INSERT INTO products (id, store_id, name, slug, price, inventory, status) VALUES ('p1', '${STORE}', 'W', 'w', 1000, 20, 'active');`
  );
  h.lite = createPrismaLite(META, nodeSqlRunner(raw), 'store-do', { unscoped: true });
  h.failMoney = false;
  h.captured.length = 0;
  h.funnelRows.length = 0;
  vi.useFakeTimers({ toFake: ['Date'] });
});
afterEach(() => vi.useRealTimers());

// [now, expected key]: winter (UTC+2), summer (UTC+3), and either side of Cairo midnight.
const CASES: Array<[string, string, number]> = [
  ['winter midday', '2026-11-14T10:00:00Z', Date.UTC(2026, 10, 13)],
  ['winter 00:30 Cairo (22:30Z)', '2026-11-13T22:30:00Z', Date.UTC(2026, 10, 13)],
  [
    'winter 23:59 Cairo (21:59Z, still previous day)',
    '2026-11-13T21:59:00Z',
    Date.UTC(2026, 10, 12),
  ],
  ['summer midday', '2026-07-14T10:00:00Z', Date.UTC(2026, 6, 13)],
  ['summer 00:30 Cairo (21:30Z)', '2026-07-13T21:30:00Z', Date.UTC(2026, 6, 13)],
];

describe('view and QR writes on the real DO op', () => {
  it.each(CASES)('recordProductView lands a row - %s', async (_n, now, key) => {
    vi.setSystemTime(new Date(now));
    expect(await recordProductView(STORE, 'p1')).toBe(true);
    expect(await recordProductView(STORE, 'p1')).toBe(true);
    expect(rows('SELECT date, count FROM product_daily_views')).toEqual([{ date: key, count: 2 }]);
  });

  it.each(CASES)('recordQrScan lands a row - %s', async (_n, now, key) => {
    vi.setSystemTime(new Date(now));
    expect(await recordQrScan(STORE, 'product', 'p1')).toBe(true);
    expect(rows('SELECT date, kind, count FROM qr_scan_daily')).toEqual([
      { date: key, kind: 'product', count: 1 },
    ]);
  });

  it('a failing DO op is reported to Sentry (not swallowed) and the shopper call still resolves false', async () => {
    vi.setSystemTime(new Date('2026-11-14T10:00:00Z'));
    h.failMoney = true;
    expect(await recordProductView(STORE, 'p1')).toBe(false);
    expect(await recordQrScan(STORE, 'product', 'p1')).toBe(false);
    expect(h.captured).toHaveLength(2);
    expect(String((h.captured[0] as [Error, unknown])[0].message)).toContain('DO unreachable');
  });

  it('a real DO op error (unknown product) is reported too', async () => {
    vi.setSystemTime(new Date('2026-11-14T10:00:00Z'));
    expect(await recordProductView(STORE, 'missing')).toBe(false);
    expect(h.captured).toHaveLength(1);
  });
});

describe('write key == read key', () => {
  it("qrStats sees today's scan (the since bound is the key, not the Cairo instant)", async () => {
    vi.setSystemTime(new Date('2026-11-14T10:00:00Z'));
    await recordQrScan(STORE, 'product', 'p1');
    const out = await qrStats(STORE, 1);
    expect(out.map(r => r.scans)).toEqual([1]);
  });

  it('the funnel rollup row for a Cairo day carries the views written that Cairo day', async () => {
    vi.setSystemTime(new Date('2026-11-13T10:00:00Z')); // Cairo day 2026-11-13
    await recordProductView(STORE, 'p1');
    await recordProductView(STORE, 'p1');
    vi.setSystemTime(new Date('2026-11-14T10:00:00Z')); // the rollup runs the next day
    await recordProductView(STORE, 'p1'); // today: not part of any rolled-up day
    await runFunnelRollup(STORE, 3);
    const byDay = new Map(
      h.funnelRows.map(r => [(r.periodDate as Date).toISOString(), r.productViews])
    );
    expect(byDay.get('2026-11-12T22:00:00.000Z')).toBe(2); // Cairo midnight of 2026-11-13
    expect(byDay.get('2026-11-11T22:00:00.000Z')).toBe(0);
  });
});

describe('D2 - the abandoned tile counts carts that BECAME abandoned that day, not the backlog', () => {
  it('a 30-day sum equals the number of carts that aged out in the window', async () => {
    const raw = h.raw as Raw;
    raw.exec('PRAGMA foreign_keys = OFF');
    vi.setSystemTime(new Date('2026-11-14T10:00:00Z'));
    const mk = (id: string, createdAt: string, recovered = false) =>
      insertSqlite(raw, 'AbandonedCart', [
        {
          id,
          storeId: STORE,
          cartId: `c-${id}`,
          cartTotal: 100,
          cartItemCount: 1,
          cartItems: [],
          status: 'pending',
          recoveredAt: recovered ? new Date(createdAt) : null,
          createdAt: new Date(createdAt),
          updatedAt: new Date(createdAt),
        },
      ]);
    // 100 old unrecovered carts, all far older than the 7-day window's reach.
    for (let i = 0; i < 100; i++) mk(`old${i}`, '2026-01-10T09:00:00Z');
    // Rolled-up days are 2026-11-07 .. 2026-11-13 (Cairo). A cart created on Cairo day D becomes abandoned on D+7.
    mk('a', '2026-10-31T09:00:00Z'); // ages out on 2026-11-07
    mk('b', '2026-11-03T09:00:00Z'); // ages out on 2026-11-10
    mk('c', '2026-11-03T12:00:00Z'); // ages out on 2026-11-10
    mk('rec', '2026-11-03T13:00:00Z', true); // recovered: never abandoned
    mk('young', '2026-11-10T09:00:00Z'); // not 7 days old yet
    await runFunnelRollup(STORE, 7);
    const per = new Map(
      h.funnelRows.map(r => [(r.periodDate as Date).toISOString(), r.ordersAbandoned as number])
    );
    expect(per.get('2026-11-06T22:00:00.000Z')).toBe(1); // Cairo 2026-11-07
    expect(per.get('2026-11-09T22:00:00.000Z')).toBe(2); // Cairo 2026-11-10
    const sum = [...per.values()].reduce((a, b) => a + b, 0);
    expect(sum).toBe(3); // not 100 * 7 + 3
  });
});
