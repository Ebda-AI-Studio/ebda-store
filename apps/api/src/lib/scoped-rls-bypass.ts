import type { Prisma } from '@force/database';

/** Anything that can run raw SQL on the transaction the bypass must live in. */
type RawClient = Pick<Prisma.TransactionClient, '$executeRaw' | '$queryRaw'>;

/**
 * Run `fn` with `app.bypass_rls = 'true'` on the CALLER'S transaction, and
 * put the GUC back the way it was afterwards — on success AND on a throw.
 *
 * WHY NOT `withRlsBypass`
 *
 * `withRlsBypass` is `basePrisma.$transaction`: a SECOND connection that
 * commits independently. Erasure-style callers need the bypassed statements to
 * be atomic with the rest of their (often ambient, request-scoped)
 * transaction, so the bypass has to be a `SET LOCAL` on that same transaction.
 *
 * WHY A HELPER (#2037)
 *
 * The open-coded shape — `SET LOCAL … 'true'; …statements…; SET LOCAL …
 * 'false'` — has two defects:
 *   1. It is not exception-safe. An application-level throw between the two
 *      (an `AppError` from a service) does not abort the Postgres transaction,
 *      so a caller that catches and continues runs the REST of its
 *      transaction with RLS off.
 *   2. It hardcodes `'false'` on the way out. A caller already running under
 *      a bypass (cron / super-admin paths) would have it silently switched
 *      OFF, turning every later store-scoped statement into a 0-row no-op.
 * This restores the PRIOR value in a `finally`.
 *
 * If `fn` failed with a statement error the transaction is aborted (25P02) and
 * the restore itself cannot run; that restore error is swallowed so the
 * original error surfaces — an aborted transaction can only roll back, which
 * discards the SET LOCAL anyway.
 */
export async function withScopedRlsBypass<T>(client: RawClient, fn: () => Promise<T>): Promise<T> {
  const rows = await client.$queryRaw<Array<{ v: string | null }>>`
    SELECT current_setting('app.bypass_rls', true) AS v`;
  const priorWasOn = rows?.[0]?.v === 'true';

  await client.$executeRaw`SET LOCAL app.bypass_rls = 'true'`;
  let fnFailed = false;
  try {
    return await fn();
  } catch (err) {
    fnFailed = true;
    throw err;
  } finally {
    try {
      if (priorWasOn) {
        await client.$executeRaw`SET LOCAL app.bypass_rls = 'true'`;
      } else {
        await client.$executeRaw`SET LOCAL app.bypass_rls = 'false'`;
      }
    } catch (restoreErr) {
      if (!fnFailed) throw restoreErr;
    }
  }
}
