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
const localHeld = new Map<string, number>();

export async function withClaimLock<T>(
  key: string,
  ttlSeconds: number,
  fn: () => Promise<T>,
  opts: { failOpen?: boolean } = {}
): Promise<{ acquired: true; value: T } | { acquired: false }> {
  const token = randomUUID();
  const lockKey = `claim-lock:${key}`;
  const client = redis.getClient();
  let release: () => Promise<void> = async () => undefined;

  if (client && redis.isAvailable()) {
    let ok: string | null;
    try {
      ok = await client.set(lockKey, token, 'EX', ttlSeconds, 'NX');
    } catch (err) {
      logger.error({ err, key }, '[claim-lock] could not claim');
      if (opts.failOpen) return { acquired: true, value: await fn() };
      throw new AppError(503, 'CLAIM_UNAVAILABLE', 'Try again shortly; nothing was changed');
    }
    if (ok !== 'OK') return { acquired: false };
    release = async () => {
      // best effort compare-and-delete: the TTL is the real backstop
      if ((await client.get(lockKey).catch(() => null)) === token) {
        await client.del(lockKey).catch(() => undefined);
      }
    };
  } else if (process.env.NODE_ENV === 'test') {
    const now = Date.now();
    if ((localHeld.get(lockKey) ?? 0) > now) return { acquired: false };
    localHeld.set(lockKey, now + ttlSeconds * 1000);
    release = async () => void localHeld.delete(lockKey);
  } else if (opts.failOpen) {
    return { acquired: true, value: await fn() };
  } else {
    throw new AppError(503, 'CLAIM_UNAVAILABLE', 'Try again shortly; nothing was changed');
  }

  try {
    return { acquired: true, value: await fn() };
  } finally {
    await release();
  }
}
