import { describe, expect, it } from 'vitest';
import { env, runInDurableObject } from 'cloudflare:test';
import type { StoreDO } from '../src/cf/store-do/store-do';

// Ruling DO-METRICS-1 (spike, 2026-11-17): what the StoreDO SQLite API can and cannot enforce at RUNTIME for a read-only, count-only metric.
// Measured on local workerd (the CI lane `workerd-integration`); these tests pin the platform facts the metric design relies on, so a platform
// change shows up here first. The enforcement of the metric path is: constant allow-list + static guard + EXPLAIN index test + numbers-only return
// type (primary) and the rollback guard below (defence in depth for DML).
const e = env as unknown as { STORE_DO: DurableObjectNamespace<StoreDO> };

async function inDo<T>(
  name: string,
  fn: (sql: SqlStorage, s: DurableObjectState) => T
): Promise<T> {
  const stub = e.STORE_DO.get(e.STORE_DO.idFromName(name));
  return runInDurableObject(stub, (_i, s) => {
    s.storage.sql.exec('CREATE TABLE IF NOT EXISTS metric_spike (id INTEGER PRIMARY KEY, v TEXT)');
    s.storage.sql.exec('DELETE FROM metric_spike');
    s.storage.sql.exec("INSERT INTO metric_spike (v) VALUES ('a'), ('b')");
    return fn(s.storage.sql, s);
  });
}
const n = (sql: SqlStorage) => sql.exec('SELECT COUNT(*) AS n FROM metric_spike').one().n as number;

describe('StoreDO read-only enforcement at runtime (DO-METRICS-1 spike)', () => {
  it('there is NO runtime read-only mode: PRAGMA query_only is not authorized (get, on or off)', async () => {
    await inDo('ro-pragma', sql => {
      for (const q of ['PRAGMA query_only', 'PRAGMA query_only = ON', 'PRAGMA query_only = OFF'])
        expect(() => sql.exec(q).toArray(), q).toThrow(/SQLITE_AUTH/);
      expect(() => sql.exec('PRAGMA writable_schema').toArray()).toThrow(/SQLITE_AUTH/);
    });
  });

  it('ATTACH is not authorized, writes are', async () => {
    await inDo('ro-attach', sql => {
      expect(() => sql.exec("ATTACH DATABASE ':memory:' AS m").toArray()).toThrow(/SQLITE_AUTH/);
      sql.exec("INSERT INTO metric_spike (v) VALUES ('c')").toArray();
      expect(n(sql)).toBe(3);
    });
  });

  it('sql.exec RUNS EVERY statement of a multi-statement string (so the allow-list must forbid ";")', async () => {
    await inDo('ro-multi', sql => {
      sql.exec('SELECT 1; DELETE FROM metric_spike').toArray();
      expect(n(sql)).toBe(0);
    });
  });

  it('EXPLAIN QUERY PLAN works, so the index test can run on workerd', async () => {
    await inDo('ro-explain', sql => {
      const plan = sql
        .exec('EXPLAIN QUERY PLAN SELECT COUNT(*) FROM metric_spike WHERE id > 1')
        .toArray() as Array<{ detail: string }>;
      expect(plan.map(p => p.detail).join(' ')).toMatch(
        /SEARCH metric_spike USING INTEGER PRIMARY KEY/
      );
    });
  });

  it('cursor.rowsRead / rowsWritten are readable: a SELECT writes 0 rows, an INSERT writes 1', async () => {
    await inDo('ro-rows', sql => {
      const sel = sql.exec('SELECT COUNT(*) AS n FROM metric_spike');
      sel.toArray();
      expect(sel.rowsWritten).toBe(0);
      const ins = sql.exec("INSERT INTO metric_spike (v) VALUES ('z')");
      ins.toArray();
      expect(ins.rowsWritten).toBe(1);
    });
  });

  it('ROLLBACK GUARD: running the statement inside transactionSync and throwing when rowsWritten > 0 undoes an INSERT and a multi-statement DELETE', async () => {
    await inDo('ro-guard', (sql, s) => {
      const run = (query: string) => () =>
        s.storage.transactionSync(() => {
          const c = sql.exec(query);
          c.toArray();
          if (c.rowsWritten > 0) throw new Error('metric wrote');
        });
      expect(run("INSERT INTO metric_spike (v) VALUES ('z')")).toThrow('metric wrote');
      expect(n(sql)).toBe(2);
      expect(run('SELECT COUNT(*) AS n FROM metric_spike; DELETE FROM metric_spike')).toThrow(
        'metric wrote'
      );
      expect(n(sql)).toBe(2);
      // a clean count passes through untouched
      expect(run('SELECT COUNT(*) AS n FROM metric_spike')).not.toThrow();
      expect(n(sql)).toBe(2);
    });
  });
});
