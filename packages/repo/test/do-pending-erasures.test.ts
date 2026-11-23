// The stuck-closure sweep's DO side: only accounts with a ledger row AND an unerased sign-in record, past the min age and backoff.
import { describe, expect, it, vi } from 'vitest';
import { openSqlite } from './diff-harness';
import { nodeSyncSql } from './node-sync-sql';
import {
  ensureCustomerAuthSchema,
  pendingErasures,
  noteErasureRetry,
} from '../src/do/customer-auth';
import { ERASURE_LEDGER_DDL } from '../src/do/erase-shopper';

vi.mock('@ebda/shared', async () => await import('../../shared/src/region'));
const H = 3_600_000;
const NOW = 1_800_000_000_000;

function setup() {
  const raw = openSqlite();
  const db = nodeSyncSql(raw);
  ensureCustomerAuthSchema(db);
  raw.exec(ERASURE_LEDGER_DDL);
  const user = (id: string, erasedAt: number | null) =>
    raw
      .prepare(
        `INSERT INTO _cauth_users (id, email, password_hash, first_name, last_name, created_at, updated_at, erased_at) VALUES (?, ?, 'h', 'A', 'B', 1, 1, ?)`
      )
      .run(id, `${id}@x.test`, erasedAt);
  const ledger = (id: string, createdAt: number) =>
    raw
      .prepare(
        `INSERT INTO erasure_ledger (user_id, store_id, scope, created_at) VALUES (?, 's1', '{}', ?)`
      )
      .run(id, createdAt);
  const ids = () =>
    (pendingErasures(db, { limit: 50 }, NOW) as { data: Array<{ userId: string }> }).data.map(
      r => r.userId
    );
  return { db, user, ledger, ids };
}

describe('pendingErasures / noteErasureRetry', () => {
  it('lists only a ledgered, unerased, old-enough account', () => {
    const t = setup();
    t.user('stuck', null);
    t.ledger('stuck', NOW - H);
    t.user('done', NOW - H);
    t.ledger('done', NOW - H);
    t.user('fresh', null);
    t.ledger('fresh', NOW - 60_000);
    t.user('noLedger', null);
    expect(t.ids()).toEqual(['stuck']);
  });
  it('backs off after a failed try (1h, then 2h) and drops out once it succeeds', () => {
    const t = setup();
    t.user('u', null);
    t.ledger('u', NOW - 5 * H);
    expect(noteErasureRetry(t.db, { userId: 'u', ok: false }, NOW)).toEqual({
      ok: true,
      data: { tries: 1 },
    });
    expect(t.ids()).toEqual([]);
    expect(
      (pendingErasures(t.db, { limit: 5 }, NOW + H + 1) as never as { data: unknown[] }).data
    ).toHaveLength(1);
    expect(noteErasureRetry(t.db, { userId: 'u', ok: false }, NOW + H + 1)).toEqual({
      ok: true,
      data: { tries: 2 },
    });
    expect(
      (pendingErasures(t.db, { limit: 5 }, NOW + 2 * H) as never as { data: unknown[] }).data
    ).toHaveLength(0);
    noteErasureRetry(t.db, { userId: 'u', ok: true }, NOW + 4 * H);
    expect(
      (pendingErasures(t.db, { limit: 5 }, NOW + 4 * H) as never as { data: unknown[] }).data
    ).toHaveLength(1);
  });
});
