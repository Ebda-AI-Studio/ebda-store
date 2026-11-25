/**
 * Review correction (Ruling NZ-D15B follow-up): `platform_audit_log.meta` is free JSON and is classified PERSONAL; the known personal
 * keys are removed on a user erasure and at store purge, the rest of the row stays. Real platform D1 schema over node:sqlite.
 */
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import classification from '../../packages/cf-schema/erasure-classification.json';
import { AUDIT_META_PII_KEYS, redactedMetaSql } from '../../apps/api/src/lib/audit-meta-redact';
import { tombstoneStatements } from '../../apps/api/src/lib/store-tombstone';
import { erasePlatformSubject, type D1Like } from '../../apps/api/src/cf/erasure/platform-subject';

const ROOT = path.resolve(__dirname, '../..');
function platform(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = OFF');
  const dir = path.join(ROOT, 'packages/cf-schema/migrations/platform');
  for (const f of fs
    .readdirSync(dir)
    .filter(f => f.endsWith('.sql'))
    .sort())
    db.exec(fs.readFileSync(path.join(dir, f), 'utf8'));
  return db;
}
function d1Of(db: DatabaseSync): D1Like {
  const stmt = (sql: string) => ({
    bind: (...v: unknown[]) => {
      const run = () => ({
        meta: { changes: Number(db.prepare(sql).run(...(v as never[])).changes) },
      });
      return {
        all: async () => ({ results: db.prepare(sql).all(...(v as never[])) as never[] }),
        first: async () => (db.prepare(sql).get(...(v as never[])) as never) ?? null,
        run: async () => run(),
        _run: run,
      };
    },
  });
  return {
    prepare: stmt,
    batch: async stmts => {
      db.exec('BEGIN');
      try {
        const out = (stmts as Array<{ _run(): { meta: { changes: number } } }>).map(s => s._run());
        db.exec('COMMIT');
        return out;
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
    },
  };
}
const PII_META = {
  email: 'mona@example.com',
  phone: '0100',
  ip: '1.2.3.4',
  name: 'Mona',
  before: { email: 'old@x.y' },
  after: { email: 'new@x.y' },
  reason: 'she asked by phone',
};
const KEPT_META = { plan: 'growth', status: 'active', ref: 'inv-9' };
function seed(db: DatabaseSync) {
  const ins = db.prepare(
    'INSERT INTO platform_audit_log (id, actor_id, action, target_type, target_id, store_id, meta, created_at) VALUES (?,?,?,?,?,?,?,?)'
  );
  ins.run(
    'a1',
    'u-1',
    'plan.change',
    'store',
    's1',
    's1',
    JSON.stringify({ ...PII_META, ...KEPT_META }),
    1
  );
  ins.run(
    'a2',
    'u-2',
    'profile.update',
    'user',
    'u-1',
    null,
    JSON.stringify({ ...PII_META, ...KEPT_META }),
    2
  ); // u-1 is the TARGET
  ins.run(
    'a3',
    'u-3',
    'other',
    'store',
    's2',
    's2',
    JSON.stringify({ ...PII_META, ...KEPT_META }),
    3
  ); // somebody else's: untouched
  ins.run('a4', null, 'empty', 'store', 's1', 's1', '{}', 4); // an empty object stays an empty object
}
const meta = (db: DatabaseSync, id: string) =>
  String(
    (db.prepare('SELECT meta FROM platform_audit_log WHERE id = ?').get(id) as { meta: string })
      .meta
  );

describe('audit log meta is personal and is redacted', () => {
  it('the classification names meta personal (not reviewed-not-personal)', () => {
    const e = (
      classification as unknown as Record<
        string,
        { piiColumns: string[]; reviewedNotPii?: string[] }
      >
    )['d1:platform_audit_log']!;
    expect(e.piiColumns).toContain('meta');
    expect(e.reviewedNotPii ?? []).not.toContain('meta');
  });

  it('the key list covers e-mail, phone, ip, name, before/after diffs and free-text reasons', () => {
    for (const k of ['email', 'phone', 'ip', 'name', 'before', 'after', 'reason'])
      expect(AUDIT_META_PII_KEYS as readonly string[]).toContain(k);
  });

  it('a user erasure removes the personal keys from rows they acted on or were the target of, keeps the rest, and leaves other rows alone', async () => {
    const db = platform();
    seed(db);
    await erasePlatformSubject(d1Of(db), { userId: 'u-1', email: null });
    for (const id of ['a1', 'a2']) {
      const m = JSON.parse(meta(db, id));
      expect(Object.keys(m).sort(), id).toEqual(['plan', 'ref', 'status']);
    }
    expect(JSON.parse(meta(db, 'a3'))).toMatchObject({ email: 'mona@example.com', plan: 'growth' });
    expect(meta(db, 'a4')).toBe('{}');
    expect(db.prepare("SELECT actor_id FROM platform_audit_log WHERE id = 'a1'").get()).toEqual({
      actor_id: null,
    });
  });

  it('a store purge redacts every row of that store, still keeping action, target, time and the non-personal keys', () => {
    const db = platform();
    seed(db);
    for (const st of tombstoneStatements('s1', 9_000))
      db.prepare(st.sql).run(...(st.params as never[]));
    expect(Object.keys(JSON.parse(meta(db, 'a1'))).sort()).toEqual(['plan', 'ref', 'status']);
    expect(meta(db, 'a4')).toBe('{}');
    expect(JSON.parse(meta(db, 'a3'))).toMatchObject({ email: 'mona@example.com' }); // another store
    expect(
      db
        .prepare("SELECT action, target_type, created_at FROM platform_audit_log WHERE id = 'a1'")
        .get()
    ).toEqual({ action: 'plan.change', target_type: 'store', created_at: 1 });
  });

  it('the redaction expression is valid SQL on its own', () => {
    const db = platform();
    expect(
      db
        .prepare(`SELECT ${redactedMetaSql().replace('"meta"', '\'{"email":"a","k":1}\'')} AS m`)
        .get()
    ).toEqual({ m: '{"k":1}' });
  });
});
