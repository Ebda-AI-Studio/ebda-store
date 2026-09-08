import { prisma, hasTenantContext } from '@force/database';

/**
 * Monotonic savepoint counter. Postgres allows a name to be reused (the newer
 * savepoint simply shadows the older one), but nested `withSavepoint` calls
 * inside one request must not release/roll back each other's, so every
 * savepoint gets its own name. Process-local and never persisted.
 */
let savepointSeq = 0;

/**
 * Run `fn` inside a Postgres SAVEPOINT whenever an ambient tenant transaction
 * is active, so a statement error inside `fn` rolls back only to the savepoint
 * instead of poisoning the whole request transaction.
 *
 * WHY THIS EXISTS
 *
 * `middleware/tenant-context.ts` wraps every store-scoped request in one
 * interactive Prisma transaction, and `@force/database`'s `prisma` proxy routes
 * every model call inside that request onto it. Postgres puts a transaction
 * into ABORTED state the moment ANY statement in it errors: every later
 * statement then fails with SQLSTATE `25P02` ("current transaction is aborted,
 * commands ignored until end of transaction block") until the transaction ends.
 *
 * That makes the ordinary `try { create() } catch (P2002) { findFirst() }`
 * idiom — the standard way to recover from a lost unique race — silently
 * INOPERATIVE inside a request: the failed INSERT aborts the transaction, so
 * the recovery query itself throws 25P02 and the request 500s. The recovery
 * path can never run. `services/accounting/journal.service.ts` hit this first
 * and solved it inline; this helper is that fix, extracted so the next call
 * site cannot forget it.
 *
 * `ROLLBACK TO SAVEPOINT` is one of the few statements Postgres still accepts
 * in an aborted transaction — that is exactly what makes this work.
 *
 * OUTSIDE a tenant context this is a straight pass-through: the caller is
 * either auto-committing (each statement its own transaction, nothing to
 * poison) or running inside its own `prisma.$transaction`, where the
 * established recovery is to retry the WHOLE transaction (see
 * `retryOnWriteConflict`) rather than recover in place. Issuing `SAVEPOINT`
 * with no transaction block open would itself error, so the guard is required,
 * not merely an optimisation.
 *
 * @example
 *   // Lost unique race recovers instead of 500ing:
 *   try {
 *     row = await withSavepoint(() => prisma.cart.create({ data }));
 *   } catch (err) {
 *     if (isP2002(err)) row = await prisma.cart.findFirst({ where });
 *     else throw err;
 *   }
 */
export async function withSavepoint<T>(fn: () => Promise<T>): Promise<T> {
  if (!hasTenantContext()) {
    return fn();
  }

  // Name is generated here, never caller-supplied — no interpolation of
  // untrusted input into the raw statement.
  const name = `fwb_sp_${++savepointSeq}`;

  await prisma.$executeRawUnsafe(`SAVEPOINT "${name}"`);
  try {
    const result = await fn();
    await prisma.$executeRawUnsafe(`RELEASE SAVEPOINT "${name}"`);
    return result;
  } catch (err) {
    await prisma.$executeRawUnsafe(`ROLLBACK TO SAVEPOINT "${name}"`);
    throw err;
  }
}
