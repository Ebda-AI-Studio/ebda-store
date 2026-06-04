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
      // Duck-type on `.code` rather than `instanceof PrismaClientKnownRequestError`:
      // P2034 is Prisma-specific, and instanceof breaks when `@force/database` is
      // mocked in unit tests (PrismaClientKnownRequestError is undefined there →
      // "Right-hand side of 'instanceof' is not an object", which would mask the
      // real error). Business errors (AppError) carry codes like NOT_FOUND, never
      // P2034, so they still propagate immediately.
      const code =
        typeof err === 'object' && err !== null && 'code' in err
          ? (err as { code?: unknown }).code
          : undefined;
      if (typeof code === 'string' && RETRYABLE_CODES.has(code) && attempt < retries) {
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
