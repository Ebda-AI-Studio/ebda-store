import { DatabaseSync } from 'node:sqlite';
import type { SyncSql } from '../src/do/sync-sql';

/** node:sqlite as the synchronous money/stock surface; transactionSync nests as savepoints like a DO. */
export function nodeSyncSql(db: DatabaseSync): SyncSql {
  let depth = 0;
  let sp = 0;
  return {
    all: (q, p) => db.prepare(q).all(...(p as never[])) as Record<string, unknown>[],
    run: (q, p) => ({ changes: Number(db.prepare(q).run(...(p as never[])).changes) }),
    transactionSync(fn) {
      const name = `s${++sp}`;
      db.exec(depth === 0 ? 'BEGIN' : `SAVEPOINT ${name}`);
      depth++;
      try {
        const out = fn();
        depth--;
        db.exec(depth === 0 ? 'COMMIT' : `RELEASE ${name}`);
        return out;
      } catch (e) {
        depth--;
        db.exec(depth === 0 ? 'ROLLBACK' : `ROLLBACK TO ${name}`);
        if (depth > 0) db.exec(`RELEASE ${name}`);
        throw e;
      }
    },
  };
}
