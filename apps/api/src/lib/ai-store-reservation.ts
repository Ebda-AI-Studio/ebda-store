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
 * two 120 s buckets (current + previous, each key expiring after 240 s). A reservation is released the moment its
 * `ai_usage` row exists (`recordUsage`, the one funnel every successful model call passes), so a settled call is never
 * counted twice. A call that FAILS never reaches `recordUsage`; its slot is not refunded by hand but expires with its
 * bucket (at most 4 minutes), which only ever tightens the cap briefly and cannot be forgotten at a call site.
 *
 * Fail-open on infrastructure (like every limiter here): with no Redis/DO the slot is `null` and `assertAiQuota` behaves as
 * before (check-then-act).
 */
import { redis as redisService } from '../services/redis.service';
import logger from './logger';

const BUCKET_SECONDS = 120;
const KEY_TTL_SECONDS = BUCKET_SECONDS * 2;

/** Slots this isolate holds, by store: release only what we took (a cached-hit or unrelated `recordUsage` must not free one). */
const held = new Map<string, string[]>();

const bucketKey = (storeId: string, bucket: number) => `ai-resv:${storeId}:${bucket}`;

/**
 * Take one slot. Resolves to the number of slots in flight for the store INCLUDING this one, or `null` when the atomic
 * counter is unavailable.
 */
export async function reserveStoreSlot(storeId: string): Promise<number | null> {
  try {
    const bucket = Math.floor(Date.now() / 1000 / BUCKET_SECONDS);
    const key = bucketKey(storeId, bucket);
    const current = await redisService.incrementRateLimit(key, KEY_TTL_SECONDS);
    if (current <= 0) return null;
    const previous = await redisService.getRateLimitCount(bucketKey(storeId, bucket - 1));
    const list = held.get(storeId) ?? [];
    list.push(key);
    held.set(storeId, list);
    return Math.max(1, current + previous);
  } catch (err) {
    logger.warn(
      { err, storeId },
      '[ai-quota] store slot reservation unavailable, falling back to count-only'
    );
    return null;
  }
}

/** Give back one slot this isolate holds (no-op when it holds none). Never throws. */
export async function releaseStoreSlot(storeId: string): Promise<void> {
  const list = held.get(storeId);
  const key = list?.pop();
  if (list && list.length === 0) held.delete(storeId);
  if (!key) return;
  try {
    await redisService.decrementRateLimit(key);
  } catch (err) {
    logger.warn(
      { err, storeId },
      '[ai-quota] store slot release failed; it expires with its bucket'
    );
  }
}
