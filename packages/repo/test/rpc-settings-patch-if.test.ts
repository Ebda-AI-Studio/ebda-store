/**
 * STORE-LIFECYCLE-1 (h): the DO's conditional settings patch (`patchStoreSettingsIf`). The condition is checked and the write is
 * made inside ONE synchronous DO transaction, so two concurrent claims of the same `deletionRequest` apply exactly once.
 */
import { describe, expect, it } from 'vitest';
import { applyStoreSettings, patchStoreSettingsIf, readStoreRecord } from '../src/rpc/settings';
import type { SqlRunner } from '../src/prisma-lite/types';
import { META, openSqlite } from './diff-harness';
import { nodeSqlRunner } from './node-sql';
import { nodeSyncSql } from './node-sync-sql';

function rig() {
  const db = openSqlite();
  const sync = nodeSyncSql(db);
  const sql: SqlRunner = { ...nodeSqlRunner(db), transactionSync: sync.transactionSync };
  db.prepare(
    `INSERT INTO store_profile (store_id, name, slug, owner_id) VALUES ('s1', 'n', 'n', 'o')`
  ).run();
  return { sql };
}
const settings = (sql: SqlRunner) =>
  readStoreRecord(sql, META as never, 's1', ['settings'])!.record.settings as Record<
    string,
    unknown
  >;
const expectPending = { key: 'deletionRequest', id: 'r1', state: 'pending' };
const claim = (sql: SqlRunner, to: unknown) =>
  patchStoreSettingsIf(sql, META as never, 's1', {
    json: { settings: { set: { deletionRequest: to } } },
    expect: expectPending,
  });

describe('patchStoreSettingsIf', () => {
  it('two concurrent claims of the same pending request: exactly ONE is applied', async () => {
    for (let i = 0; i < 20; i++) {
      const { sql } = rig();
      applyStoreSettings(sql, META as never, 's1', {
        settings: { base: 1, deletionRequest: { id: 'r1', state: 'pending' } },
      });
      const [a, b] = await Promise.all([
        Promise.resolve().then(() => claim(sql, { id: 'r1', state: 'executing' })),
        Promise.resolve().then(() => claim(sql, { id: 'r1', state: 'cancelled' })),
      ]);
      expect([a.applied, b.applied].filter(Boolean), `round ${i}`).toHaveLength(1);
      const winner = a.applied ? 'executing' : 'cancelled';
      expect(settings(sql).deletionRequest, `round ${i}`).toEqual({ id: 'r1', state: winner });
      expect(settings(sql).base).toBe(1);
    }
  });

  it('a stale expectation (other id, other state, key missing) writes nothing', () => {
    const { sql } = rig();
    applyStoreSettings(sql, META as never, 's1', {
      settings: { deletionRequest: { id: 'r2', state: 'pending' } },
    });
    expect(claim(sql, { id: 'r1', state: 'executing' }).applied).toBe(false); // other id
    applyStoreSettings(sql, META as never, 's1', {
      settings: { deletionRequest: { id: 'r1', state: 'cancelled' } },
    });
    expect(claim(sql, { id: 'r1', state: 'executing' }).applied).toBe(false); // other state
    applyStoreSettings(sql, META as never, 's1', { settings: {} });
    expect(claim(sql, { id: 'r1', state: 'executing' }).applied).toBe(false); // key missing
    expect(settings(sql).deletionRequest).toBeUndefined();
  });

  it('a matching claim applies and keeps every other settings key', () => {
    const { sql } = rig();
    applyStoreSettings(sql, META as never, 's1', {
      settings: { base: 1, deletionRequest: { id: 'r1', state: 'pending' } },
    });
    expect(claim(sql, { id: 'r1', state: 'executing' }).applied).toBe(true);
    expect(settings(sql)).toEqual({ base: 1, deletionRequest: { id: 'r1', state: 'executing' } });
  });
});
