import type { SqlRunner } from './types';

/** The slice of a Durable Object's `ctx.storage` the runner uses (SQLite-backed). */
export interface DoStorageLike {
  sql: {
    exec(
      query: string,
      ...bindings: unknown[]
    ): { toArray(): Record<string, unknown>[]; rowsWritten: number };
  };
  transactionSync<T>(fn: () => T): T;
  transaction<T>(fn: () => Promise<T>): Promise<T>;
}

/**
 * Rows the statement itself changed. `rowsWritten` also counts every index entry and trigger-written row (an INSERT into an
 * indexed table reports 2+, a DELETE of an indexed row too), so `changes === 1` as a claim-win test lost every claim. SQLite's
 * `changes()` is the statement's own row count; nothing written (rowsWritten 0) is 0 without asking, so a no-op never reads a
 * stale value from an earlier statement. Guard: tests/unit/d1-changes-guard.test.ts; test: apps/api/workers-do/d1-changes-class.test.ts.
 */
function statementChanges(storage: Pick<DoStorageLike, 'sql'>, rowsWritten: number): number {
  if (rowsWritten === 0) return 0;
  return Number(storage.sql.exec('SELECT changes() AS n').toArray()[0]?.n ?? 0);
}

/**
 * prisma-lite's SqlRunner over a Durable Object. Single writes are ONE synchronous `transactionSync` (atomic, and
 * nothing else can run in between: no await). The interactive `$transaction` uses `storage.transaction`.
 */
export function doSqlRunner(storage: DoStorageLike): SqlRunner {
  return {
    all: (q, p) => storage.sql.exec(q, ...p).toArray(),
    run: (q, p) => {
      const c = storage.sql.exec(q, ...p);
      c.toArray();
      return { changes: statementChanges(storage, c.rowsWritten) };
    },
    transactionSync: fn => storage.transactionSync(fn),
    transaction: fn => storage.transaction(async () => fn()),
  };
}

import type { SyncSql } from '../do/sync-sql';

/** The money/stock core's synchronous surface over a Durable Object (`transactionSync`, never async). */
export function doSyncSql(storage: DoStorageLike): SyncSql {
  return {
    all: (q, p) => storage.sql.exec(q, ...p).toArray(),
    run: (q, p) => {
      const c = storage.sql.exec(q, ...p);
      c.toArray();
      return { changes: statementChanges(storage, c.rowsWritten) };
    },
    transactionSync: fn => storage.transactionSync(fn),
  };
}
