/**
 * Leader Election Helper
 *
 * Provides a lightweight per-tick leader election pattern built on the
 * existing Redis client. Each replica races to `SET key instanceId NX PX ttl`
 * on every cron tick; only the winner runs the work body. The interval itself
 * stays alive on all replicas so the work resumes quickly if the leader
 * crashes and the TTL expires.
 *
 * When Redis is absent (local dev / Redis unavailable), the helper falls
 * back to "this instance is always the leader" so single-instance dev
 * behaves identically to before.
 *
 * Usage:
 *   import { withLeaderLock } from '../lib/leader-election';
 *
 *   setInterval(() => {
 *     withLeaderLock('my-job', 60_000, async () => {
 *       // only runs on the replica that wins the lock
 *     }).catch(err => logger.error({ err }, 'job failed'));
 *   }, 60_000);
 */

import { redis } from '../services/redis.service';
import logger from './logger';

// Stable per-process identity: pid + random hex suffix generated at startup.
// pid alone would collide across Railway replicas that both get pid=1 inside
// their container. The random suffix makes it unique across restarts too.
const INSTANCE_ID = `${process.pid}-${Math.random().toString(36).slice(2, 10)}`;

/**
 * Attempt to acquire a Redis leader lock for `lockKey` with a TTL of
 * `ttlMs` milliseconds. If acquired, run `fn` and release the lock when
 * done (regardless of success/failure). Returns true if this instance was
 * the leader and ran `fn`, false if another instance already holds the lock.
 *
 * When Redis is unavailable the helper assumes leadership (single-instance
 * dev keeps all jobs running).
 */
export async function withLeaderLock(
  lockKey: string,
  ttlMs: number,
  fn: () => Promise<void>
): Promise<boolean> {
  const client = redis.getClient();

  // No Redis — behave as the sole leader so nothing is skipped in dev
  if (!client || !redis.isAvailable()) {
    await fn();
    return true;
  }

  const redisKey = `leader:${lockKey}`;
  const ttlSeconds = Math.ceil(ttlMs / 1000);

  // NX = only set if key does not already exist
  const result = await client.set(redisKey, INSTANCE_ID, 'EX', ttlSeconds, 'NX');
  if (result !== 'OK') {
    // Another replica holds the lock — skip this tick
    logger.debug({ lockKey, instanceId: INSTANCE_ID }, '[leader-election] skipped (lock held)');
    return false;
  }

  logger.debug(
    { lockKey, instanceId: INSTANCE_ID },
    '[leader-election] acquired lock, running job'
  );

  try {
    await fn();
  } finally {
    // Only delete our own lock to avoid evicting a successor that raced in
    // (e.g. if fn() ran longer than ttlMs and the lock expired + was reacquired).
    // Lua script ensures atomicity of the read-then-delete.
    const luaScript = `
      if redis.call("get", KEYS[1]) == ARGV[1] then
        return redis.call("del", KEYS[1])
      else
        return 0
      end
    `;
    await client.eval(luaScript, 1, redisKey, INSTANCE_ID).catch(err => {
      logger.warn({ err, lockKey }, '[leader-election] lock release failed (non-fatal)');
    });
  }

  return true;
}

export { INSTANCE_ID };
