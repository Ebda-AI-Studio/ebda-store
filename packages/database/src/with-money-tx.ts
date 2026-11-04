import type { PrismaClient, Prisma } from '@prisma/client';
import { registerTxHooks, runCommitHooks } from './tx-hooks';
import { routeTx } from './tx-route';

/**
 * Wraps `prisma.$transaction` with the money-safe defaults required by
 * feedback-prisma-maxwait-default-2s-trap (Neon pgbouncer P2028 guard).
 *
 * Prisma's `$transaction` defaults `maxWait` to 2s. Under burst load on the
 * Neon pooler that fires P2028 intermittently and surfaces as a 500. Use this
 * helper for EVERY interactive transaction; per-call `opts` override the
 * defaults (e.g. `{ timeout: 60000 }` for long bulk transactions).
 */
export function withMoneyTx<T>(
  prisma: Pick<PrismaClient, '$transaction'>,
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
  opts?: { maxWait?: number; timeout?: number }
): Promise<T> {
  // Ruling NZ-D19: this transaction's own after-COMMIT hooks (`afterTxCommit(tx, ...)`): fired only if THIS transaction commits.
  const hooks: Array<() => unknown> = [];
  return (async () => {
    const result = await (prisma.$transaction as (...args: unknown[]) => Promise<T>)(
      (tx: Prisma.TransactionClient) => {
        registerTxHooks(tx as object, hooks);
        return fn(routeTx(tx));
      },
      {
        maxWait: opts?.maxWait ?? 10000,
        timeout: opts?.timeout ?? 30000,
      }
    );
    await runCommitHooks(hooks); // a rollback threw above: the hooks are dropped with it
    return result;
  })();
}
