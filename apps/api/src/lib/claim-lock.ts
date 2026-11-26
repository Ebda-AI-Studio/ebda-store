import { randomUUID } from 'node:crypto';
import { redis } from '../services/redis.service';
import { AppError } from '../middleware/error-handler';
import logger from './logger';

/**
 * A short mutual-exclusion claim on a strongly consistent store (`SET NX EX`: Redis, or the AuthState Durable Object on the
 * Worker). Needed where a decision rests on "who wrote first": on the platform D1, prisma-lite `updateMany` is a SELECT of keys
 * then one write per key, so two concurrent claims can BOTH see `count: 1`. Under this lock the count (or a read-then-write)
 * is serialised, so exactly one caller runs `fn`.
 *
 * `acquired: false` = someone else holds it (the caller decides: skip, or 409). When the store cannot arbitrate: `failOpen`
 * runs `fn` anyway (an alert that may duplicate), otherwise 503 and nothing runs. Under vitest with no Redis a process-local
 * map stands in (like `mcp/merchant-confirm-token.ts`). The key expires by itself (`ttlSeconds`) if the holder dies.
 */
const localHeld = new Map<string, { token: string; until: number }>();

/**
 * Release = ONE atomic compare-and-delete (money review M1): a GET then a DEL could, after the TTL expired between them and
 * another caller re-acquired, delete THAT caller's lock. The exact script text is the one `CfRedis.eval` runs as the
 * AuthState DO's single-call `delIfEquals` (a DO is single-threaded) and real Redis runs as Lua.
 */
const RELEASE_SCRIPT = `
      if redis.call("get", KEYS[1]) == ARGV[1] then
        return redis.call("del", KEYS[1])
      else
        return 0
      end
    `;

/**
 * The holder's guard (money review M2): the lock is only trusted until `ttl - margin`. A slow `fn` (a D1 or provider call)
 * can outlive the TTL, the key expires and a second caller enters, so `fn` calls `assertHeld()` IMMEDIATELY before its
 * irreversible write (enable + ledger, the verified flip): past the deadline it throws 409 `CLAIM_EXPIRED` and writes
 * nothing; the caller retries.
 */
interface ClaimGuard {
  assertHeld(): void;
}

// pq-allow(unused-export): test seam, imported by tests/unit/claim-lock.test.ts
export function claimDeadlineMs(ttlSeconds: number): number {
  const margin = Math.min(5, ttlSeconds * 0.2);
  return Math.max(0, (ttlSeconds - margin) * 1000);
}

export async function withClaimLock<T>(
  key: string,
  ttlSeconds: number,
  fn: (guard: ClaimGuard) => Promise<T>,
  opts: { failOpen?: boolean } = {}
): Promise<{ acquired: true; value: T } | { acquired: false }> {
  const token = randomUUID();
  const lockKey = `claim-lock:${key}`;
  const client = redis.getClient();
  let release: () => Promise<void> = async () => undefined;
  const acquiredAt = Date.now();
  const guard: ClaimGuard = {
    assertHeld() {
      if (Date.now() - acquiredAt >= claimDeadlineMs(ttlSeconds)) {
        throw new AppError(
          409,
          'CLAIM_EXPIRED',
          'This took too long and was stopped before any change; try again'
        );
      }
    },
  };
  // fail-open paths run without a lock: the guard never expires there (nothing to protect)
  const noGuard: ClaimGuard = { assertHeld: () => undefined };

  if (client && redis.isAvailable()) {
    let ok: string | null;
    try {
      ok = await client.set(lockKey, token, 'EX', ttlSeconds, 'NX');
    } catch (err) {
      logger.error({ err, key }, '[claim-lock] could not claim');
      if (opts.failOpen) return { acquired: true, value: await fn(noGuard) };
      throw new AppError(503, 'CLAIM_UNAVAILABLE', 'Try again shortly; nothing was changed');
    }
    if (ok !== 'OK') return { acquired: false };
    release = async () => {
      // atomic compare-and-delete (M1); a failure is harmless: the TTL is the backstop
      await client
        .eval(RELEASE_SCRIPT, 1, lockKey, token)
        .catch(err => logger.warn({ err, key }, '[claim-lock] release failed (the TTL clears it)'));
    };
  } else if (process.env.NODE_ENV === 'test') {
    const now = Date.now();
    const held = localHeld.get(lockKey);
    if (held && held.until > now) return { acquired: false };
    localHeld.set(lockKey, { token, until: now + ttlSeconds * 1000 });
    // compare-and-delete, the same rule as the stores (a single synchronous step here)
    release = async () => {
      if (localHeld.get(lockKey)?.token === token) localHeld.delete(lockKey);
    };
  } else if (opts.failOpen) {
    return { acquired: true, value: await fn(noGuard) };
  } else {
    throw new AppError(503, 'CLAIM_UNAVAILABLE', 'Try again shortly; nothing was changed');
  }

  try {
    return { acquired: true, value: await fn(guard) };
  } finally {
    await release();
  }
}
