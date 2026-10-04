/**
 * A Durable Object `SqlStorage` look-alike over `node:sqlite`, so the AuthState command engine
 * (apps/api/src/cf/auth-state-core.ts) can be unit-tested on Node. The same engine is exercised on a
 * real SQLite-backed DO in apps/api/workers-test.
 */
import { DatabaseSync } from 'node:sqlite';
import type { SqlLike } from '@api/cf/auth-state-core';

export function createSqlite(): SqlLike & { db: DatabaseSync } {
  const db = new DatabaseSync(':memory:');
  return {
    db,
    exec(query: string, ...bindings: unknown[]) {
      const stmt = db.prepare(query);
      const returnsRows = /^\s*(select|with)\b/i.test(query);
      const rows = returnsRows
        ? (stmt.all(...(bindings as never[])) as Array<Record<string, unknown>>)
        : [];
      const info = returnsRows ? { changes: 0 } : stmt.run(...(bindings as never[]));
      return {
        toArray: () => rows.map(r => ({ ...r })),
        one: () => {
          if (rows.length !== 1) throw new Error(`expected exactly one row, got ${rows.length}`);
          return { ...rows[0] };
        },
        rowsWritten: Number(info.changes),
      };
    },
  };
}
