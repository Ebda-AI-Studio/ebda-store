import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

export const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const REPO = path.resolve(PKG, '../..');

export function migrationFiles(target: 'store' | 'platform'): string[] {
  const dir = path.join(PKG, 'migrations', target);
  return fs
    .readdirSync(dir)
    .filter(f => f.endsWith('.sql'))
    .sort()
    .map(f => path.join(dir, f));
}

/** An in-memory SQLite with foreign keys ON (a DO and D1 both enforce them), all migrations applied. */
export function openDb(target: 'store' | 'platform', times = 1): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  for (let i = 0; i < times; i++)
    for (const f of migrationFiles(target)) {
      const sql = fs.readFileSync(f, 'utf8');
      // `-- @once` files (generated ALTER TABLE ADD COLUMN) are not idempotent: a real database applies them once
      if (i > 0 && /^-- @once\b/m.test(sql)) continue;
      db.exec(sql);
    }
  return db;
}

export function readJson<T>(rel: string): T {
  return JSON.parse(fs.readFileSync(path.join(PKG, rel), 'utf8')) as T;
}

export function tableNames(db: DatabaseSync): string[] {
  return (
    db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
      )
      .all() as { name: string }[]
  ).map(r => r.name);
}

export function expectThrows(fn: () => unknown, re: RegExp): void {
  let err: unknown;
  try {
    fn();
  } catch (e) {
    err = e;
  }
  if (!err) throw new Error(`expected a throw matching ${re}`);
  if (!re.test(String((err as Error).message)))
    throw new Error(`expected /${re}/, got: ${(err as Error).message}`);
}
