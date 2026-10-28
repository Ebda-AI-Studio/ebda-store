import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const here = path.dirname(fileURLToPath(import.meta.url));
export const SCHEMA = path.resolve(here, '../../cf-schema/migrations/store');

/** the harness splitter, copied logic-free via import of the real function is not possible (cloudflare:workers) */
export function splitSql(text: string): string[] {
  const out: string[] = [];
  let cur: string[] = [];
  let inTrigger = false;
  for (const line of text.split('\n')) {
    if (cur.length === 0 && (line.trim() === '' || line.startsWith('--'))) continue;
    cur.push(line);
    if (/^\s*CREATE\s+TRIGGER/i.test(line)) inTrigger = true;
    const t = line.trimEnd();
    if (inTrigger ? /^END;$/i.test(t.trim()) : t.endsWith(';')) {
      out.push(cur.join('\n'));
      cur = [];
      inTrigger = false;
    }
  }
  return out;
}

/** A DO-shaped store: the generated StoreDO schema in node:sqlite, wrapped like ctx.storage.sql. */
export function storeDo() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  for (const f of ['0001_init.sql', '0002_invariants.sql'])
    db.exec(fs.readFileSync(path.join(SCHEMA, f), 'utf8'));
  const sql = {
    exec(q: string, ...b: unknown[]) {
      const rows = db.prepare(q).all(...(b as never[])) as Record<string, unknown>[];
      return Object.assign(rows, { toArray: () => rows });
    },
  };
  const transactionSync = (fn: () => void) => {
    db.exec('BEGIN');
    try {
      fn();
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  };
  return { db, sql, transactionSync };
}

export function ndjson(head: Record<string, unknown>, rows: unknown[][]): string {
  return [JSON.stringify(head), ...rows.map(r => JSON.stringify(r))].join('\n') + '\n';
}
