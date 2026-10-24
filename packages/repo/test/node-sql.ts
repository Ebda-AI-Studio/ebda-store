import { DatabaseSync } from 'node:sqlite';
import type { SqlRunner } from '../src/prisma-lite/types';

/** node:sqlite adapter used by tests and local tools; the DO uses `ctx.storage.sql` with the same interface. */
export function nodeSqlRunner(db: DatabaseSync): SqlRunner {
  let depth = 0;
  return {
    all: (sql, params) => db.prepare(sql).all(...(params as never[])) as Record<string, unknown>[],
    run: (sql, params) => ({
      changes: Number(db.prepare(sql).run(...(params as never[])).changes),
    }),
    async transaction(fn) {
      if (depth > 0) return fn(); // Prisma has no nested transactions: join the open one
      depth++;
      db.exec('BEGIN');
      try {
        const out = await fn();
        db.exec('COMMIT');
        return out;
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      } finally {
        depth--;
      }
    },
  };
}
