/**
 * Follow-up of the #1109 review (Ruling NZ-D15B): the payment-proof objects of a purged store are deleted, not just unlinked.
 * Real platform D1 schema over node:sqlite, a fake object store.
 */
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import {
  deleteStoreProofFiles,
  type ProofFileDeps,
} from '../../apps/api/src/lib/store-proof-files';

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
    else if (c.name === 'id') row[c.name] = `${table}-${Math.random().toString(36).slice(2)}`;
    else if (c.notnull && c.dflt_value == null)
      row[c.name] = /INT/i.test(c.type) ? 1 : `x-${Math.random().toString(36).slice(2)}`;
  }
  const names = Object.keys(row);
  db.prepare(
    `INSERT INTO "${table}" (${names.map(n => `"${n}"`).join(',')}) VALUES (${names.map(() => '?').join(',')})`
  ).run(...(Object.values(row) as never[]));
}

function harness(failOn?: string) {
  const db = platform();
  const priv: string[] = [];
  const pub: string[] = [];
  const deps: ProofFileDeps = {
    d1All: async (sql, ...p) => db.prepare(sql).all(...(p as never[])) as never[],
    d1Run: async (sql, ...p) => Number(db.prepare(sql).run(...(p as never[])).changes),
    deletePrivate: async key => {
      if (key === failOn) throw new Error('r2 down');
      priv.push(key);
    },
    deletePublic: async key => void pub.push(key),
    urlToKey: url =>
      url.startsWith('https://media.test/') ? url.slice('https://media.test/'.length) : null,
    belongsToStore: (key, id) => key.startsWith(`stores/${id}/`),
  };
  return { db, deps, priv, pub };
}
const S = 's1';

describe('payment-proof files of a purged store', () => {
  it('deletes the unmarked receipt images and marks them, skips the ones already deleted, leaves other stores alone', async () => {
    const h = harness();
    insert(h.db, 'instapay_receipts', {
      id: 'r1',
      store_id: S,
      storage_key: 'stores/s1/instapay/a.jpg',
    });
    insert(h.db, 'instapay_receipts', {
      id: 'r2',
      store_id: S,
      storage_key: 'stores/s1/instapay/b.jpg',
      image_deleted_at: 5,
    });
    insert(h.db, 'instapay_receipts', {
      id: 'r3',
      store_id: 'other',
      storage_key: 'stores/other/instapay/c.jpg',
    });
    const r = await deleteStoreProofFiles(S, h.deps, 9_000);
    expect(r.receipts).toBe(1);
    expect(h.priv).toEqual(['stores/s1/instapay/a.jpg']);
    expect(
      h.db.prepare("SELECT image_deleted_at AS d FROM instapay_receipts WHERE id = 'r1'").get()
    ).toEqual({ d: 9_000 });
    expect(
      h.db.prepare("SELECT image_deleted_at AS d FROM instapay_receipts WHERE id = 'r2'").get()
    ).toEqual({ d: 5 });
    expect(
      h.db.prepare("SELECT image_deleted_at AS d FROM instapay_receipts WHERE id = 'r3'").get()
    ).toEqual({ d: null });
  });

  it('deletes a claim proof of THIS store, unlinks an external or foreign one without deleting anything', async () => {
    const h = harness();
    insert(h.db, 'manual_payment_claims', {
      id: 'c1',
      store_id: S,
      proof_url: 'https://media.test/stores/s1/proofs/x.png',
    });
    insert(h.db, 'manual_payment_claims', {
      id: 'c2',
      store_id: S,
      proof_url: 'https://elsewhere.example/p.png',
    });
    insert(h.db, 'manual_payment_claims', {
      id: 'c3',
      store_id: S,
      proof_url: 'https://media.test/stores/OTHER/proofs/y.png',
    });
    const r = await deleteStoreProofFiles(S, h.deps);
    expect(r.claims).toBe(3);
    expect(h.pub).toEqual(['stores/s1/proofs/x.png']); // never another store's object
    expect(
      h.db
        .prepare('SELECT count(*) AS n FROM manual_payment_claims WHERE proof_url IS NOT NULL')
        .get()
    ).toEqual({ n: 0 });
  });

  it('a failed delete throws, leaves its row pointing at the object, and a rerun finishes the job', async () => {
    const h = harness('stores/s1/instapay/bad.jpg');
    insert(h.db, 'instapay_receipts', {
      id: 'a-ok',
      store_id: S,
      storage_key: 'stores/s1/instapay/good.jpg',
    });
    insert(h.db, 'instapay_receipts', {
      id: 'b-bad',
      store_id: S,
      storage_key: 'stores/s1/instapay/bad.jpg',
    });
    await expect(deleteStoreProofFiles(S, h.deps, 9_000)).rejects.toThrow('r2 down');
    expect(
      h.db.prepare('SELECT id FROM instapay_receipts WHERE image_deleted_at IS NULL').all()
    ).toEqual([{ id: 'b-bad' }]);
    const h2 = {
      ...h,
      deps: { ...h.deps, deletePrivate: async (k: string) => void h.priv.push(k) },
    };
    expect((await deleteStoreProofFiles(S, h2.deps, 9_500)).receipts).toBe(1);
    expect(
      h.db
        .prepare('SELECT count(*) AS n FROM instapay_receipts WHERE image_deleted_at IS NULL')
        .get()
    ).toEqual({ n: 0 });
    expect((await deleteStoreProofFiles(S, h2.deps)).receipts).toBe(0); // idempotent
  });
});
