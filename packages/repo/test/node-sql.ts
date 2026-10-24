import { AsyncLocalStorage } from 'node:async_hooks';
import { DatabaseSync } from 'node:sqlite';
import type { SqlRunner } from '../src/prisma-lite/types';

/**
 * node:sqlite adapter used by tests and local tools; the DO uses `ctx.storage.sql` with the same interface.
 *
 * Models the contract a DO runner must honour: top-level transactions run ONE AT A TIME (an unrelated request's
 * write waits for the open transaction and can never be rolled back with it), and work started INSIDE a
 * transaction body (tracked through AsyncLocalStorage) runs in a SAVEPOINT of that transaction.
 */
export function nodeSqlRunner(db: DatabaseSync): SqlRunner {
  const inTx = new AsyncLocalStorage<boolean>();
  let spSeq = 0;
  let queue: Promise<unknown> = Promise.resolve();
  return {
    all: (sql, params) => db.prepare(sql).all(...(params as never[])) as Record<string, unknown>[],
    run: (sql, params) => ({
      changes: Number(db.prepare(sql).run(...(params as never[])).changes),
    }),
    async transaction(fn) {
      if (inTx.getStore()) {
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
      const run = async () =>
        inTx.run(true, async () => {
          db.exec('BEGIN');
          try {
            const out = await fn();
            db.exec('COMMIT');
            return out;
          } catch (e) {
            db.exec('ROLLBACK');
            throw e;
          }
        });
      const next = queue.then(run, run);
      queue = next.catch(() => undefined);
      return next;
    },
  };
}
