// Ruling DO-METRICS-1: operator metrics on the StoreDO schema (node:sqlite). Proves the enforcement the ruling names: constant allow-list,
// static guard, EXPLAIN index test, numbers-only shape and the rollback guard. Runtime read-only does not exist (workerd refuses query_only).
import { describe, expect, it } from 'vitest';
import { openSqlite } from './diff-harness';
import { nodeSyncSql } from './node-sync-sql';
import { ensureMoneyOpsSchema, MONEY_OP_NAMES, runMoneyOp } from '../src/do/money-ops';
import { DO_METRICS, DO_METRIC_NAMES, runDoMetric, type DoMetricDef } from '../src/do/do-metrics';

function rig() {
  const raw = openSqlite();
  const db = nodeSyncSql(raw);
  ensureMoneyOpsSchema(db);
  return { raw, db };
}
const FIVE_NAMED = ['journal_unbalanced', 'journal_unrepaired', 'push_subscriptions_active'];

describe('static guard over the allow-list', () => {
  it('has exactly the metrics the ruling names for the store DB (journal_repaired / stores_with_push_enabled are not store SQL)', () => {
    expect([...DO_METRIC_NAMES].sort()).toEqual([...FIVE_NAMED].sort());
  });
  for (const name of DO_METRIC_NAMES) {
    const sql = DO_METRICS[name].sql;
    it(`${name}: one statement, a SELECT, no write, DDL, pragma or attach`, () => {
      expect(sql).not.toContain(';');
      expect(sql.trim()).toMatch(/^SELECT\b/i);
      expect(sql).not.toMatch(
        /\b(INSERT|UPDATE|DELETE|REPLACE|CREATE|DROP|ALTER|ATTACH|DETACH|PRAGMA|VACUUM|REINDEX)\b/i
      );
      expect(sql).toMatch(/\bCOUNT\(\*\) AS n\b/);
      expect(DO_METRICS[name].doc.length).toBeGreaterThan(10);
    });
  }
  it('doMetric is a registered money op', () => expect(MONEY_OP_NAMES).toContain('doMetric'));
});

describe('EXPLAIN QUERY PLAN: no unindexed scan except the documented one', () => {
  // A metric that must scan a whole table has to be listed here with the reason (Ruling DO-METRICS-1: the index test). None today.
  const DOCUMENTED_SCANS: Record<string, string[]> = {};
  for (const name of DO_METRIC_NAMES) {
    it(`${name}`, () => {
      const { raw } = rig();
      const plan = (
        raw.prepare(`EXPLAIN QUERY PLAN ${DO_METRICS[name].sql}`).all() as Array<{ detail: string }>
      ).map(p => p.detail);
      const scans = plan
        .map(d => d.match(/^SCAN (\w+)(?: AS \w+)?$/)?.[1])
        .filter((t): t is string => !!t);
      expect(plan, plan.join(' | ')).toBeTruthy();
      expect(scans.sort()).toEqual((DOCUMENTED_SCANS[name] ?? []).sort());
    });
  }
});

describe('values on seeded data', () => {
  function seed() {
    const { raw, db } = rig();
    raw.exec(`
      INSERT INTO accounts (id, store_id, code, name_en, type) VALUES ('a','s1','1000','Cash','asset'), ('b','s1','4000','Sales','revenue');
      INSERT INTO journal_entries (id, store_id, entry_number, posted_at, source, source_id, status) VALUES
        ('e1','s1','1',1,'order','o1','posted'),
        ('e2','s1','2',1,'expense','x1','posted'),
        ('e3','s1','3',1,'expense','x2','draft');
      INSERT INTO journal_lines (id, entry_id, account_id, debit, credit) VALUES
        ('l1','e1','a',100,0), ('l2','e1','b',0,100),
        ('l3','e2','a',50,0),  ('l4','e2','b',0,40),
        ('l5','e3','a',9,0);
      INSERT INTO push_subscriptions (id, store_id, endpoint, p256dh, auth) VALUES ('p1','s1','https://e/1','k','a'), ('p2','s1','https://e/2','k','a');
    `);
    return { raw, db };
  }
  it('journal_unbalanced counts posted unbalanced entries only (a draft does not count)', () => {
    const { db } = seed();
    expect(runDoMetric(db, { name: 'journal_unbalanced' })).toEqual({ n: 1 });
  });
  it('push_subscriptions_active counts the rows', () => {
    const { db } = seed();
    expect(runDoMetric(db, { name: 'push_subscriptions_active' })).toEqual({ n: 2 });
  });
  it('an empty store reads zero for every metric', () => {
    const { db } = rig();
    for (const n of DO_METRIC_NAMES) expect(runDoMetric(db, { name: n })).toEqual({ n: 0 });
  });
  it('reads through the money-op entry point too, and returns numbers only', () => {
    const { db } = seed();
    const r = runMoneyOp(db, 's1', 'doMetric', { name: 'push_subscriptions_active' }) as Record<
      string,
      unknown
    >;
    expect(Object.keys(r)).toEqual(['n']);
    expect(typeof r.n).toBe('number');
  });
});

describe('what a caller cannot do', () => {
  it('rejects a name that is not on the list, including SQL text and prototype keys', () => {
    const { db } = rig();
    for (const name of ['x', 'DROP TABLE orders', 'toString', '__proto__', '', 5, undefined])
      expect(() => runDoMetric(db, { name } as never), String(name)).toThrow(/unknown metric/);
  });
  it('ROLLBACK GUARD: a metric that writes throws and leaves the data untouched', () => {
    const { raw, db } = rig();
    raw.exec(
      "INSERT INTO push_subscriptions (id, store_id, endpoint, p256dh, auth) VALUES ('p1','s1','https://e/1','k','a')"
    );
    const poisoned: Record<string, DoMetricDef> = {
      w: {
        doc: 'a metric that writes (test only)',
        sql: "INSERT INTO push_subscriptions (id, store_id, endpoint, p256dh, auth) VALUES ('p9','s1','https://e/9','k','a') RETURNING 1 AS n",
      },
    };
    expect(() => runDoMetric(db, { name: 'w' }, poisoned)).toThrow(/must not write/);
    expect(runDoMetric(db, { name: 'push_subscriptions_active' })).toEqual({ n: 1 });
  });
  it('SHAPE GUARD: a metric that returns a row or extra columns is refused', () => {
    const { db } = rig();
    const bad: Record<string, DoMetricDef> = {
      rows: {
        doc: 'returns a data column (test only)',
        sql: 'SELECT id AS n, store_id FROM push_subscriptions',
      },
      two: { doc: 'returns two rows (test only)', sql: 'SELECT 1 AS n UNION ALL SELECT 2' },
    };
    db.run(
      "INSERT INTO push_subscriptions (id, store_id, endpoint, p256dh, auth) VALUES ('p1','s1','https://e/1','k','a')",
      []
    );
    expect(() => runDoMetric(db, { name: 'rows' }, bad)).toThrow();
    expect(() => runDoMetric(db, { name: 'two' }, bad)).toThrow(/one integer column/);
  });
});
