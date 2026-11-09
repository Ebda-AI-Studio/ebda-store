/**
 * Once-only sentinels for the gold crons' notices (a Durable Object key on Workers: not a `cache:` key).
 * Claim AFTER the notice went out, never before: a send that throws leaves the sentinel unset, so the
 * next run tries again (Ruling B5-36). With no store to dedupe against this THROWS: sending unmarked would
 * email the owner every run, and skipping silently would lose the notice for good.
 */
import { redis } from '../redis.service';

const TTL_SECONDS = 3 * 24 * 60 * 60;

export class SentinelStoreUnavailableError extends Error {
  constructor(cause?: unknown) {
    super('gold sentinel store (redis) is unavailable');
    this.name = 'SentinelStoreUnavailableError';
    if (cause) (this as { cause?: unknown }).cause = cause;
  }
}

function client() {
  const c = redis.getClient();
  if (!c) throw new SentinelStoreUnavailableError();
  return c;
}

/** Has this notice been marked sent? Throws {@link SentinelStoreUnavailableError} with no store. */
export async function wasSent(key: string): Promise<boolean> {
  try {
    return (await client().get(key)) !== null;
  } catch (err) {
    if (err instanceof SentinelStoreUnavailableError) throw err;
    throw new SentinelStoreUnavailableError(err);
  }
}

/** Mark a notice sent (after it went out). */
export async function markSent(key: string): Promise<void> {
  try {
    await client().set(key, '1', 'EX', TTL_SECONDS);
  } catch (err) {
    if (err instanceof SentinelStoreUnavailableError) throw err;
    throw new SentinelStoreUnavailableError(err);
  }
}

/** End a notice's episode so the next one (a new disagreement) may be sent again. */
export async function clearSent(key: string): Promise<void> {
  try {
    await client().del(key);
  } catch (err) {
    if (err instanceof SentinelStoreUnavailableError) throw err;
    throw new SentinelStoreUnavailableError(err);
  }
}
