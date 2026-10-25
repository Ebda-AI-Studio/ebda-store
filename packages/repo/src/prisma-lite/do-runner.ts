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
 * prisma-lite's SqlRunner over a Durable Object. Single writes are ONE synchronous `transactionSync` (atomic, and
 * nothing else can run in between: no await). The interactive `$transaction` uses `storage.transaction`.
 */
export function doSqlRunner(storage: DoStorageLike): SqlRunner {
  return {
    all: (q, p) => storage.sql.exec(q, ...p).toArray(),
    run: (q, p) => {
      const c = storage.sql.exec(q, ...p);
      c.toArray();
      return { changes: c.rowsWritten };
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
      return { changes: c.rowsWritten };
    },
    transactionSync: fn => storage.transactionSync(fn),
  };
}
