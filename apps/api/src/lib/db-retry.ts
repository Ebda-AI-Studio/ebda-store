import logger from './logger';

// Postgres serialization failure / deadlock, surfaced by Prisma as P2034:
// "Transaction failed due to a write conflict or a deadlock. Please retry."
// This is the EXPECTED outcome of a Serializable transaction under concurrency
// — not an error to surface to the user. The companion to Serializable
// isolation is a bounded retry; without it, concurrent writers (e.g. many
// shoppers adding the same hot product at once) get a 500.
const RETRYABLE_CODES = new Set(['P2034']);

interface RetryOpts {
  retries?: number; // max retry attempts after the first try (default 4)
  baseDelayMs?: number; // base backoff unit (default 20ms)
  label?: string; // for logging which call retried
  // Extra Prisma error codes to treat as transient + retry. Used by the cart
  // add paths, which run at Read Committed (not Serializable): a concurrent add
  // of the same line to the SAME cart loses the (cartId, productId, variantId)
  // unique race as P2002 — retrying the whole tx lets the re-run see the
  // winner's row and merge the quantity instead of 500ing. Only pass codes that
  // a transaction RE-RUN can actually resolve.
  extraRetryCodes?: string[];
}

/**
 * Extracts a Prisma/Postgres error code to duck-type against.
 *
 * A raw-SQL failure (e.g. `reconcileWarehouseStockToAggregate`'s
 * `FOR UPDATE` + `INSERT … ON CONFLICT` statements) is wrapped by Prisma as
 * `P2010` ("Raw query failed") with the ACTUAL Postgres error code (e.g.
 * `40P01` deadlock_detected, `40001` serialization_failure) nested at
 * `err.meta.code`, NOT at `err.code` — unlike an ORM-level interactive
 * `$transaction` conflict, which Prisma surfaces directly as `P2034` on
 * `err.code`. Verified empirically against real Postgres (see
 * `.superpowers/sdd/task-2-report.md` fix wave 1). Callers that pass raw
 * Postgres codes (`40P01`, `40001`) via `extraRetryCodes` need BOTH `err.code`
 * and `err.meta.code` checked; callers only using Prisma's own codes (like
 * `P2002`) are unaffected since `err.code` already matches for them.
 *
 * issue 2012: a CONNECTION-establishment failure (P1001 "Can't reach database
 * server", P1002 "timed out") is raised as `PrismaClientInitializationError`,
 * which carries its code on `errorCode` — not `code`. Without harvesting it,
 * `feature.service.ts`'s `extraRetryCodes: ['P1001','P1002','P1017']` could
 * never match the class it was written for.
 */
function extractRetryCodes(err: unknown): string[] {
  if (typeof err !== 'object' || err === null) return [];
  const codes: string[] = [];
  const code = (err as { code?: unknown }).code;
  if (typeof code === 'string') codes.push(code);
  const metaCode = (err as { meta?: { code?: unknown } }).meta?.code;
  if (typeof metaCode === 'string') codes.push(metaCode);
  // Over the driver adapter (`engineType = "client"`) a raw-query failure carries NO `meta.code`:
  // the Postgres SQLSTATE is `meta.driverAdapterError.cause.originalCode` (40P01 deadlock,
  // 40001 serialization failure, 57P01 admin shutdown, ...) and an unreachable server is
  // `cause.kind = 'DatabaseNotReachable'`. Without these the raw-SQL retries (the warehouse
  // reconcile's FOR UPDATE, the P1001 retry on the feature read) never matched.
  const cause = (
    err as {
      meta?: { driverAdapterError?: { cause?: { originalCode?: unknown; kind?: unknown } } };
    }
  ).meta?.driverAdapterError?.cause;
  if (typeof cause?.originalCode === 'string') codes.push(cause.originalCode);
  if (cause?.kind === 'DatabaseNotReachable') codes.push('P1001');
  if (cause?.kind === 'SocketTimeout') codes.push('P1002');
  if (cause?.kind === 'TransactionWriteConflict') codes.push('P2034');
  // Connection-establishment failures (P1001 "can't reach database server",
  // P1002 "timed out") are thrown as `PrismaClientInitializationError`, whose
  // code lives on `errorCode` — `code` is undefined on that class (issue
  // 1989 / issue 2012). Without this, a caller listing P1001/P1002 in
  // `extraRetryCodes` never actually retried them.
  const errorCode = (err as { errorCode?: unknown }).errorCode;
  if (typeof errorCode === 'string') codes.push(errorCode);
  return codes;
}

/**
 * Run `fn` (typically a `prisma.$transaction(...)` with Serializable isolation)
 * and retry on a write-conflict/deadlock (P2034) with exponential backoff +
 * jitter. Non-retryable errors (including AppError thrown inside the
 * transaction, e.g. INSUFFICIENT_INVENTORY) propagate immediately — only the
 * serialization-failure code is retried, so business rules are never masked.
 */
export async function retryOnWriteConflict<T>(
  fn: () => Promise<T>,
  opts: RetryOpts = {}
): Promise<T> {
  const retries = opts.retries ?? 4;
  const base = opts.baseDelayMs ?? 20;
  let attempt = 0;

  for (;;) {
    try {
      return await fn();
    } catch (err) {
      // Duck-type on `.code`/`.meta.code` rather than `instanceof
      // PrismaClientKnownRequestError`: P2034 is Prisma-specific, and
      // instanceof breaks when `@ebda/database` is mocked in unit tests
      // (PrismaClientKnownRequestError is undefined there → "Right-hand side
      // of 'instanceof' is not an object", which would mask the real error).
      // Business errors (AppError) carry codes like NOT_FOUND, never P2034
      // or a Postgres SQLSTATE, so they still propagate immediately.
      const codes = extractRetryCodes(err);
      const retryable = codes.some(
        code => RETRYABLE_CODES.has(code) || (opts.extraRetryCodes?.includes(code) ?? false)
      );
      const code = codes[0];
      if (retryable && attempt < retries) {
        attempt++;
        // Exponential backoff with jitter so concurrent retriers de-synchronise
        // instead of colliding again on the same tick.
        const delay = base * 2 ** (attempt - 1) + Math.floor(Math.random() * base);
        logger.warn(
          { code, attempt, retries, delay, label: opts.label },
          'db write conflict — retrying transaction'
        );
        await new Promise(resolve => setTimeout(resolve, delay));
        continue;
      }
      throw err;
    }
  }
}

// ---------------------------------------------------------------------------
// Idempotent READS — transient connection drops
// ---------------------------------------------------------------------------

/** Prisma connection-level codes: P1001 can't reach, P1002 timed out, P1017 server closed. */
const TRANSIENT_CONNECTION_CODES = new Set(['P1001', 'P1002', 'P1017']);

/**
 * The same failures arrive without a usable code when Prisma wraps them as a
 * `PrismaClientUnknownRequestError` (EBDA-API-2E surfaced as "Server has
 * closed the connection."). Matched on the message as a fallback only.
 */
const TRANSIENT_CONNECTION_MESSAGE =
  /can't reach database server|server has closed the connection|connection terminated|econnreset/i;

/**
 * Is `err` a connection that dropped or never opened — the Neon pooler idling
 * out a socket or a compute blip (EBDA-API-2D / 2E / 2F)? NOT a statement
 * error: nothing the query said was wrong, so re-running it is safe.
 */
export function isTransientConnectionError(err: unknown): boolean {
  if (extractRetryCodes(err).some(code => TRANSIENT_CONNECTION_CODES.has(code))) return true;
  const message = err instanceof Error ? err.message : '';
  return TRANSIENT_CONNECTION_MESSAGE.test(message);
}

interface RetryReadOpts {
  retries?: number; // retry attempts after the first try (default 2)
  baseDelayMs?: number; // backoff unit (default 40ms → ~40–80ms, then ~80–120ms)
  label?: string;
}

/**
 * Re-run an IDEMPOTENT READ after a transient connection error: at most
 * `retries` extra attempts (default 2) with a short jittered backoff, and only
 * for {@link isTransientConnectionError}. Anything else propagates at once.
 *
 * READS ONLY. A write that died mid-flight may or may not have committed;
 * re-running it can double-apply. Writes that need retrying go through
 * {@link retryOnWriteConflict}, which retries only errors a re-run provably
 * resolves. `getCached`'s fetcher is the one caller — a cache fill is a read by
 * construction.
 */
export async function retryTransientRead<T>(
  fn: () => Promise<T>,
  opts: RetryReadOpts = {}
): Promise<T> {
  const retries = opts.retries ?? 2;
  const base = opts.baseDelayMs ?? 40;
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= retries || !isTransientConnectionError(err)) throw err;
      const delay = base * 2 ** attempt + Math.floor(Math.random() * base);
      logger.warn(
        {
          code: extractRetryCodes(err)[0],
          attempt: attempt + 1,
          retries,
          delay,
          label: opts.label,
        },
        'transient db connection error on read — retrying'
      );
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
}
