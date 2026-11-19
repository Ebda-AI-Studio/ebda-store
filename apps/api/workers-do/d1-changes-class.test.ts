import { describe, expect, it } from 'vitest';
import { env, applyD1Migrations, runInDurableObject } from 'cloudflare:test';
import { doSyncSql, doSqlRunner } from '@ebda-src/repo';

// Defect class (Ebda Store PR #791): a write's "changes" is not the statement's row count.
//  - D1: `meta.changes` includes rows written by triggers (billing_events_tax_fill makes one insert report 2). prisma-lite's own
//    `count` (createMany / updateMany / deleteMany) is a ROW count, never `changes`, so Prisma callers are unaffected; raw D1 callers
//    must test `changes > 0` (billing-d1.ts does).
//  - Durable Object: `rowsWritten` also counts index entries and trigger rows. doSyncSql / doSqlRunner used to report it as
//    `changes`, so customer-auth's `claimed.changes !== 1` (DELETE of an indexed token) and the stock books' `r.changes !== 1`
//    refused every claim. They now report SQLite `changes()`.
const e = env as unknown as {
  PLATFORM_DB: D1Database;
  TEST_PLATFORM_MIGRATIONS: unknown[];
  STORE_DO: DurableObjectNamespace;
};

describe('write counts that include index / trigger rows', () => {
  it('D1: one billing_events insert reports changes > 1 (tax_fill trigger): raw `=== 1` would call a real write a loss', async () => {
    await applyD1Migrations(e.PLATFORM_DB, e.TEST_PLATFORM_MIGRATIONS as never);
    await e.PLATFORM_DB.prepare(
      "INSERT OR IGNORE INTO stores (id, name, slug, owner_id) VALUES ('s-chg', 's-chg', 's-chg', 'o')"
    ).run();
    const r = await e.PLATFORM_DB.prepare(
      "INSERT INTO billing_events (id, store_id, type, amount_minor, currency, provider, idempotency_key, status) VALUES ('ev-chg', 's-chg', 'renewal', 1000, 'EGP', 'manual', 'k-chg', 'pending')"
    ).run();
    expect(r.meta.changes).toBeGreaterThan(1);
    const replay = await e.PLATFORM_DB.prepare(
      "INSERT INTO billing_events (id, store_id, type, amount_minor, currency, provider, idempotency_key, status) VALUES ('ev-chg2', 's-chg', 'renewal', 1000, 'EGP', 'manual', 'k-chg', 'pending') ON CONFLICT (idempotency_key) DO NOTHING"
    ).run();
    expect(replay.meta.changes).toBe(0); // so `> 0` is the win test
  });

  it('StoreDO: doSyncSql.run / doSqlRunner.run report the statement row count, not rowsWritten (index + trigger rows)', async () => {
    const stub = e.STORE_DO.get(e.STORE_DO.idFromName('d1-changes-class'));
    const m = await runInDurableObject(stub, (_i, s) => {
      const sql = s.storage.sql;
      sql.exec(
        'CREATE TABLE IF NOT EXISTS zz_claim (id TEXT PRIMARY KEY, tok TEXT, used_at INTEGER)'
      );
      sql.exec('CREATE UNIQUE INDEX IF NOT EXISTS zz_claim_tok ON zz_claim (tok)');
      sql.exec('CREATE INDEX IF NOT EXISTS zz_claim_used ON zz_claim (used_at)');
      sql.exec('CREATE TABLE IF NOT EXISTS zz_log (n INTEGER)');
      sql.exec(
        'CREATE TRIGGER IF NOT EXISTS zz_t AFTER INSERT ON zz_claim BEGIN INSERT INTO zz_log VALUES (1); END'
      );
      const raw = sql.exec("INSERT INTO zz_claim VALUES ('raw', 'raw-tok', NULL)");
      raw.toArray();
      const sync = doSyncSql(s.storage as never);
      const runner = doSqlRunner(s.storage as never);
      return {
        rawRowsWritten: raw.rowsWritten,
        insert: sync.run("INSERT INTO zz_claim VALUES ('a', 'tok-a', NULL)", []).changes,
        update: sync.run('UPDATE zz_claim SET used_at = 5 WHERE id = ? AND used_at IS NULL', ['a'])
          .changes,
        updateAgain: sync.run('UPDATE zz_claim SET used_at = 6 WHERE id = ? AND used_at IS NULL', [
          'a',
        ]).changes,
        del: sync.run('DELETE FROM zz_claim WHERE id = ?', ['a']).changes,
        delMissing: sync.run('DELETE FROM zz_claim WHERE id = ?', ['a']).changes,
        runnerInsert: runner.run("INSERT INTO zz_claim VALUES ('b', 'tok-b', NULL)", []).changes,
      };
    });
    expect(m.rawRowsWritten).toBeGreaterThan(1); // the bug: table + 2 indexes + trigger row
    expect(m).toMatchObject({
      insert: 1,
      update: 1,
      updateAgain: 0,
      del: 1,
      delMissing: 0,
      runnerInsert: 1,
    });
  });
});
