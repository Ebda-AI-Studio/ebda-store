// Node path only (createPrismaClient). Closes a Prisma 6.19.3 driver-adapter leak.
//
// Cause (read from @prisma/client runtime, TransactionManager): `startTransaction` awaits
// `adapter.startTransaction()`; AFTER it resolves (BEGIN already sent, connection checked out) it switches on the
// manager's status for that transaction. `$disconnect()` -> `cancelAllTransactions()` flips a still-"waiting" start to
// "closing", so the switch falls to `default: "Unknown transaction status."` and throws WITHOUT ever calling
// commit/rollback on the adapter transaction. The pg client stays checked out, `idle in transaction` on the server, and
// `pool.end()` (disposeExternalPool) then waits for it forever. Seen on CI in repo-factory-orders-contract.test.ts
// (noteOrderCreated -> withStore -> runInTenantContext still starting when the suite tore down). Ruling NZ-TEARDOWN-DIAG-1.
//
// Fix at the one seam we own: wrap the adapter so a transaction Prisma never closes is rolled back and released.
//   - dispose(): any transaction still open after a macrotask is an orphan (Prisma's own cancelAll already closed the
//     real ones): ROLLBACK + release it BEFORE the pool is ended.
//   - a transaction that returns after dispose() began is rolled back at once.
//   - watchdog: a transaction with no commit/rollback after ORPHAN_TX_MS (longer than any transaction timeout we set,
//     30 s) is rolled back and released.
import type {
  SqlDriverAdapter,
  SqlDriverAdapterFactory,
  Transaction,
} from '@prisma/driver-adapter-utils';

export const ORPHAN_TX_MS = 40_000;

const rollbackQuietly = async (tx: Transaction): Promise<void> => {
  try {
    await tx.executeRaw({ sql: 'ROLLBACK', args: [], argTypes: [] });
  } catch {
    /* the connection may already be gone */
  }
  try {
    await tx.rollback();
  } catch {
    /* already released */
  }
};

export function guardOrphanTransactions(
  adapter: SqlDriverAdapter,
  opts: { orphanMs?: number } = {}
): SqlDriverAdapter {
  const orphanMs = opts.orphanMs ?? ORPHAN_TX_MS;
  const open = new Map<Transaction, ReturnType<typeof setTimeout>>();
  let disposed = false;

  const reap = async (tx: Transaction): Promise<void> => {
    const timer = open.get(tx);
    if (timer === undefined && !open.has(tx)) return; // closed meanwhile
    clearTimeout(timer);
    open.delete(tx);
    await rollbackQuietly(tx);
  };

  const track = (tx: Transaction): Transaction => {
    const close = (fn: () => Promise<void>) => async () => {
      clearTimeout(open.get(tx));
      open.delete(tx);
      await fn();
    };
    const commit = tx.commit.bind(tx);
    const rollback = tx.rollback.bind(tx);
    tx.commit = close(commit);
    tx.rollback = close(rollback);
    const timer = setTimeout(() => void reap(tx), orphanMs);
    timer.unref?.();
    open.set(tx, timer);
    return tx;
  };

  return new Proxy(adapter, {
    get(target, prop, receiver) {
      if (prop === 'startTransaction') {
        return async (...args: Parameters<SqlDriverAdapter['startTransaction']>) => {
          const tx = await target.startTransaction(...args);
          track(tx);
          if (disposed) void reap(tx);
          return tx;
        };
      }
      if (prop === 'dispose') {
        return async () => {
          disposed = true;
          await new Promise<void>(r => setImmediate(r));
          await Promise.all([...open.keys()].map(reap));
          return target.dispose();
        };
      }
      const v = Reflect.get(target, prop, receiver);
      return typeof v === 'function' ? v.bind(target) : v;
    },
  });
}

export function guardOrphanTransactionsFactory(
  factory: SqlDriverAdapterFactory
): SqlDriverAdapterFactory {
  return {
    provider: factory.provider,
    adapterName: factory.adapterName,
    connect: async () => guardOrphanTransactions(await factory.connect()),
  };
}
