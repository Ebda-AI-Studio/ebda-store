/**
 * Class check of the #1109 review (Ruling STORE-ROW-TOMBSTONE-1): no path removes a D1 `stores` row of an existing store, because
 * Ebda's billing_events, instapay_receipts, manual_payment_claims, billing_reminders, store_subscriptions, trust_requests and
 * ai_usage reference it ON DELETE CASCADE. Proven on the real D1 schema with foreign keys on, and by a source scan of the directory modules.
 */
import fs from 'node:fs';
import os from 'node:os';
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

/**
 * Source scan over every place that could remove a `stores` row: apps/api/src, apps/api/scripts, scripts/. A new hard delete anywhere
 * fails here. Allowed: the rollback of a store created seconds ago (no billing exists yet), the local seed file, and one Postgres-only
 * maintenance script for TEST stores (Prisma over the removed Postgres; it never touches the D1 platform database).
 */
const HARD_DELETE = [/DELETE FROM "?stores"?\b/i, /\.store\.delete(Many)?\(/];
const ALLOWED: Record<string, string> = {
  'apps/api/src/lib/store-create-do.ts':
    'rollbackDoStore: creation rollback of a store made seconds ago, no billing exists yet',
  'apps/api/scripts/cf-seed.sql': 'local seed data reset, not a deployed path',
  'scripts/admin-test-store-cleanup.mjs':
    'manual Postgres-only cleanup of TEST stores (Prisma over Postgres, removed in prod); never runs against D1',
};
const EXT = /\.(ts|tsx|mjs|js|cjs|sql|sh)$/;

function walk(dir: string, out: string[] = []): string[] {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name !== 'node_modules') walk(p, out);
    } else if (
      EXT.test(e.name) &&
      !/\.(test|spec)\.(ts|tsx|mjs|js)$/.test(e.name) &&
      !e.name.endsWith('.d.ts')
    )
      out.push(p);
  }
  return out;
}
export function findHardDeletes(roots: string[], base: string): string[] {
  const hits: string[] = [];
  for (const root of roots)
    for (const f of walk(path.join(base, root))) {
      const rel = path.relative(base, f).split(path.sep).join('/');
      if (rel in ALLOWED) continue;
      const text = fs.readFileSync(f, 'utf8');
      for (const re of HARD_DELETE) if (re.test(text)) hits.push(`${rel} ~ ${re}`);
    }
  return hits;
}
const ROOTS = ['apps/api/src', 'apps/api/scripts', 'scripts'];

describe('source scan: no code path deletes a stores row', () => {
  it('apps/api/src, apps/api/scripts and scripts/ contain no DELETE FROM stores / store.delete outside the allowlist', () => {
    expect(findHardDeletes(ROOTS, ROOT)).toEqual([]);
  });
  it('the scan sees the allowed files (a scanner that sees nothing would pass anything)', () => {
    for (const rel of Object.keys(ALLOWED)) {
      const text = fs.readFileSync(path.join(ROOT, rel), 'utf8');
      expect(
        HARD_DELETE.some(re => re.test(text)),
        rel
      ).toBe(true);
    }
    expect(ROOTS.flatMap(r => walk(path.join(ROOT, r))).length).toBeGreaterThan(200);
  });
  it('MUTATION: a hard delete planted anywhere in the scanned roots is caught (raw SQL and Prisma shapes)', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hard-delete-scan-'));
    try {
      fs.mkdirSync(path.join(tmp, 'apps/api/src/lib'), { recursive: true });
      fs.mkdirSync(path.join(tmp, 'scripts'), { recursive: true });
      fs.writeFileSync(
        path.join(tmp, 'apps/api/src/lib/evil.ts'),
        'await db.prepare(\'DELETE FROM "stores" WHERE "id" = ?\').bind(id).run();'
      );
      fs.writeFileSync(
        path.join(tmp, 'scripts/evil.mjs'),
        'await tx.store.deleteMany({ where: { id } });'
      );
      fs.writeFileSync(
        path.join(tmp, 'scripts/fine.mjs'),
        "await db.prepare('DELETE FROM store_staff WHERE store_id = ?');"
      );
      const hits = findHardDeletes(['apps/api/src', 'scripts'], tmp);
      expect(hits.map(h => h.split(' ~ ')[0]).sort()).toEqual([
        'apps/api/src/lib/evil.ts',
        'scripts/evil.mjs',
      ]);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
