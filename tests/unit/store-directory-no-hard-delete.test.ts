/**
 * Class check of the #1109 review (Ruling STORE-ROW-TOMBSTONE-1): no path removes a D1 `stores` row of an existing store, because
 * Ebda's billing_events, instapay_receipts, manual_payment_claims, billing_reminders, store_subscriptions, trust_requests and
 * ai_usage reference it ON DELETE CASCADE. Proven on the real D1 schema with foreign keys on, and by a source scan of the directory modules.
 */
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { tombstoneStoreDirectoryRow } from '../../apps/api/src/lib/store-directory-tombstone';

const ROOT = path.resolve(__dirname, '../..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

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
function insert(db: DatabaseSync, table: string, set: Record<string, unknown>) {
  const cols = db.prepare(`PRAGMA table_info("${table}")`).all() as {
    name: string;
    type: string;
    notnull: number;
    dflt_value: unknown;
  }[];
  const ddl = String(
    (db.prepare('SELECT sql FROM sqlite_master WHERE name = ?').get(table) as { sql: string }).sql
  );
  const allowed: Record<string, string> = {};
  for (const m of ddl.matchAll(/CHECK \("(\w+)" IN \('([^']+)'/g)) allowed[m[1]!] = m[2]!;
  const row: Record<string, unknown> = {};
  for (const c of cols) {
    if (c.name in set) row[c.name] = set[c.name];
    else if (c.name in allowed) row[c.name] = allowed[c.name];
    else if (c.name === 'scopes') row[c.name] = '[]';
    else if (c.name === 'id') row[c.name] = `${table}-${Math.random().toString(36).slice(2)}`;
    else if (c.notnull && c.dflt_value == null)
      row[c.name] = /INT/i.test(c.type) ? 1 : `x-${Math.random().toString(36).slice(2)}`;
  }
  const names = Object.keys(row);
  db.prepare(
    `INSERT INTO "${table}" (${names.map(n => `"${n}"`).join(',')}) VALUES (${names.map(() => '?').join(',')})`
  ).run(...(Object.values(row) as never[]));
}
const d1Of = (db: DatabaseSync) => ({
  prepare: (sql: string) => ({
    bind: (...v: unknown[]) => ({ run: async () => db.prepare(sql).run(...(v as never[])) }),
  }),
});
const n = (db: DatabaseSync, sql: string, ...p: unknown[]) =>
  Number((db.prepare(sql).get(...(p as never[])) as { n: number }).n);

describe("a store removed from the directory keeps Ebda's billing records", () => {
  it('tombstoneStoreDirectoryRow leaves billing_events / instapay_receipts / manual_payment_claims / store_subscriptions in place', async () => {
    const db = platform();
    insert(db, 'stores', {
      id: 'sx',
      slug: 'old',
      owner_id: 'o',
      deleted_at: null,
      storage_backend: 'pg',
    });
    for (const t of [
      'billing_events',
      'instapay_receipts',
      'manual_payment_claims',
      'store_subscriptions',
    ])
      insert(db, t, { store_id: 'sx' });
    db.exec('PRAGMA foreign_keys = ON');
    await tombstoneStoreDirectoryRow(d1Of(db), 'sx', 7_000);
    for (const t of [
      'billing_events',
      'instapay_receipts',
      'manual_payment_claims',
      'store_subscriptions',
    ])
      expect(n(db, `SELECT count(*) n FROM "${t}" WHERE store_id = 'sx'`), t).toBe(1);
    expect(
      db.prepare("SELECT slug, status, deleted_at AS d FROM stores WHERE id = 'sx'").get()
    ).toEqual({ slug: '~purged~sx', status: 'inactive', d: 7_000 });
  });
});

describe('source scan: no directory module deletes a stores row', () => {
  it.each([
    'apps/api/src/lib/store-directory-sync.ts',
    'apps/api/src/lib/store-directory-reconcile.ts',
  ])('%s has no DELETE FROM stores and uses the tombstone', rel => {
    const src = read(rel);
    expect(src).not.toMatch(/DELETE FROM "?stores"?/i);
    expect(src).toMatch(/tombstoneStoreDirectoryRow/);
  });
  it('the one intentional hard delete left is the rollback of a store created a moment ago (no billing exists yet)', () => {
    expect(read('apps/api/src/lib/store-create-do.ts')).toMatch(/DELETE FROM "stores"/);
  });
});
