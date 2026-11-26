/**
 * Atomic in-flight reservation for the per-store daily AI slice (issue #845, Ruling AI-SLICE-ATOMIC-1).
 *
 * `assertAiQuota` counts `ai_usage` rows, and a row is written only AFTER the model call, so N concurrent calls all read
 * `cap - 1` and all pass. A reservation closes that: before counting, the call takes one slot from an atomic counter
 * (`incrementRateLimit` = INCR + EXPIRE on the AuthState Durable Object through the ioredis-shaped client, the same primitive
 * the rate limiters and lockouts already use; a D1 `UPDATE ... WHERE used < cap` row would add a table, a migration and
 * a per-store DO hop for a number that only has to be right for a few seconds). The call then refuses when
 * `rows + slots in flight (itself included) > cap`.
 *
 * The counter holds only IN-FLIGHT calls, never the day's total, so it needs no seeding and no midnight reset: it is
 * two 120 s buckets (current + previous, each key expiring after 240 s). `assertAiQuota` returns the slot as a handle
 * and every caller releases it in a `finally` once the call is over (after its `ai_usage` row is written on success,
 * at once on failure), so neither a failed call, a retry nor a check-only probe holds a slot; the bucket expiry (at
 * most 4 minutes) is only the backstop for an isolate that dies mid-call. `tests/unit/ai-quota-every-model-call.test.ts`
 * style ratchet: tests/unit/ai-quota-atomic-slice.test.ts checks every reserving call site has a release.
 *
 * Fail-open on infrastructure (like every limiter here): with no Redis/DO the slot is `null` and `assertAiQuota` behaves as
 * before (check-then-act).
 */
import { redis as redisService } from '../services/redis.service';
import logger from './logger';

const BUCKET_SECONDS = 120;
const KEY_TTL_SECONDS = BUCKET_SECONDS * 2;

const bucketKey = (storeId: string, bucket: number) => `ai-resv:${storeId}:${bucket}`;

/** One reserved slot. `release` gives back exactly this slot, once (idempotent); it never throws. */
export interface StoreSlot {
  /** Slots in flight for the store INCLUDING this one. */
  inFlight: number;
  release(): Promise<void>;
}

/**
 * Take one slot. Resolves to its handle, or `null` when the atomic counter is unavailable (fail-open, count-only).
 * The caller releases it when the call is over, success or failure (assertAiQuota's handle, released in a finally).
 */
export async function reserveStoreSlot(storeId: string): Promise<StoreSlot | null> {
  try {
    const bucket = Math.floor(Date.now() / 1000 / BUCKET_SECONDS);
    const key = bucketKey(storeId, bucket);
    const current = await redisService.incrementRateLimit(key, KEY_TTL_SECONDS);
    if (current <= 0) return null;
    const previous = await redisService.getRateLimitCount(bucketKey(storeId, bucket - 1));
    let released = false;
    return {
      inFlight: Math.max(1, current + previous),
      async release() {
        if (released) return;
        released = true;
        try {
          await redisService.decrementRateLimit(key);
        } catch (err) {
          logger.warn(
            { err, storeId },
            '[ai-quota] store slot release failed; it expires with its bucket'
          );
        }
      },
    };
  } catch (err) {
    logger.warn(
      { err, storeId },
      '[ai-quota] store slot reservation unavailable, falling back to count-only'
    );
    return null;
  }
}
