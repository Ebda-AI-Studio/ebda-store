/**
 * Per-account store-creation velocity (SP5 task 4): one account may create at
 * most `STORES_PER_ACCOUNT_PER_DAY` stores per rolling 24h (default 2), on top
 * of the lifetime `MAX_SELF_SERVE_STORES_PER_OWNER` cap. Soft-deleted stores
 * count - delete-and-recreate is exactly the squatting loop this stops.
 *
 * `super_admin` provisioning is operator-controlled and never goes through here.
 */
import { withUser } from '@ebda/database';
import { countOwnerStoresCreatedSince } from '../lib/store-create-do';
import { abuseConfig } from '../lib/abuse-config';
import { AppError } from '../middleware/error-handler';
import { redis } from './redis.service';

const DAY_MS = 24 * 60 * 60 * 1000;

export async function assertStoreCreationBudget(
  ownerId: string,
  now: Date = new Date()
): Promise<void> {
  const cap = abuseConfig.storesPerAccountPerDay();
  const since = new Date(now.getTime() - DAY_MS);
  // N-18: with STORE_CREATE_ON_DO on, the larger of the Postgres and D1 counts; off = Postgres only.
  const recent = await countOwnerStoresCreatedSince(ownerId, since, () =>
    withUser(ownerId, tx => tx.store.count({ where: { ownerId, createdAt: { gte: since } } }))
  );
  if (recent >= cap) {
    throw new AppError(
      429,
      'STORE_DAILY_LIMIT',
      'You have created several stores today. Please try again tomorrow or contact support.'
    );
  }
}

/**
 * Run `fn` (the create) while holding a short per-owner lock so a burst of
 * parallel creates cannot all read the same count and slip past the cap. The
 * lock fails OPEN when Redis is down (see `RedisService.acquireLock`).
 */
export async function withStoreCreationLock<T>(ownerId: string, fn: () => Promise<T>): Promise<T> {
  const name = `store-create:${ownerId}`;
  const got = await redis.acquireLock(name, 30);
  if (!got) {
    throw new AppError(
      429,
      'STORE_DAILY_LIMIT',
      'A store is already being created for this account. Please wait a moment.'
    );
  }
  try {
    return await fn();
  } finally {
    await redis.releaseLock(name).catch(() => undefined);
  }
}
