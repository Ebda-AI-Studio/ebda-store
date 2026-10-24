import { DatabaseSync } from 'node:sqlite';
import type { SqlRunner } from './types';

/** node:sqlite adapter used by tests and local tools; the DO uses `ctx.storage.sql` with the same interface. */
export function nodeSqlRunner(db: DatabaseSync): SqlRunner {
  return {
    all: (sql, params) => db.prepare(sql).all(...(params as never[])) as Record<string, unknown>[],
    run: (sql, params) => ({
      changes: Number(db.prepare(sql).run(...(params as never[])).changes),
    }),
  };
}
