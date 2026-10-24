import { DatabaseSync } from 'node:sqlite';
import type { SqlRunner } from '../src/prisma-lite/types';

/** node:sqlite adapter used by tests and local tools; the DO uses `ctx.storage.sql` with the same interface. */
export function nodeSqlRunner(db: DatabaseSync): SqlRunner {
  let depth = 0;
  let spSeq = 0;
  return {
    all: (sql, params) => db.prepare(sql).all(...(params as never[])) as Record<string, unknown>[],
    run: (sql, params) => ({
      changes: Number(db.prepare(sql).run(...(params as never[])).changes),
    }),
    async transaction(fn) {
      if (depth > 0) {
        // inside an open transaction every unit of work gets a SAVEPOINT: an error caught by the caller leaves no
        // half-applied nested write behind (a DO runner must give the same guarantee)
        const sp = `sp_${++spSeq}`;
        db.exec(`SAVEPOINT ${sp}`);
        try {
          const out = await fn();
          db.exec(`RELEASE ${sp}`);
          return out;
        } catch (e) {
          db.exec(`ROLLBACK TO ${sp}`);
          db.exec(`RELEASE ${sp}`);
          throw e;
        }
      }
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
