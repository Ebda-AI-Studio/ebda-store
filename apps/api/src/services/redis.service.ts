import Redis from 'ioredis';
import { CfRedis } from '../cf/ioredis-cf';
import { isWorkers } from '../lib/runtime';
import { config } from '../config';
import logger from '../lib/logger';

// ==========================================
// Redis Service
// Provides caching, CSRF tokens, sessions, and rate limiting
// ==========================================

class RedisService {
  private client: Redis | null = null;
  private isConnected = false;

  async connect(): Promise<void> {
    if (this.client && this.isConnected) return;

    try {
      // Workers: no sockets and no Redis. The same command surface runs on the AuthState
      // Durable Object (strong state) and KV (`cache:*`), see cf/ioredis-cf.ts.
      this.client = isWorkers
        ? (new CfRedis({ keyPrefix: config.redisKeyPrefix || undefined }) as unknown as Redis)
        : new Redis(config.redisUrl, {
            maxRetriesPerRequest: 3,
            retryStrategy(times: number) {
              return Math.min(times * 500, 30000);
            },
            lazyConnect: true,
            // When REDIS_KEY_PREFIX is set (e.g. `ebda-staging:` on staging),
            // ioredis transparently prefixes every command's keys. All
            // consumers (cache.set/get, csrf, session, ratelimit, lock,
            // email-queue) get the prefix for free — no per-call changes
            // needed. Prod leaves the env var unset so the prefix is ''
            // and existing keys stay shaped as `cache:*`, `csrf:*`, etc.
            keyPrefix: config.redisKeyPrefix || undefined,
          });

      this.client.on('connect', () => {
        this.isConnected = true;
        logger.info(
          { keyPrefix: config.redisKeyPrefix || '(none)' },
          '[REDIS] Connected successfully'
        );
      });

      // issue 1963: `isConnected` used to be latched false by ANY `error`
      // event with only `connect` to re-arm it, so an error that did not tear
      // the socket down left every `isAvailable()` caller (rate limiters,
      // CSRF, sessions, caches) on its fallback indefinitely. `ready` re-arms
      // it after every (re)connect, and an error only clears it when the
      // client really is not ready.
      this.client.on('ready', () => {
        this.isConnected = true;
      });

      this.client.on('error', (err: Error) => {
        logger.error({ err: err.message }, '[REDIS] Connection error');
        this.isConnected = this.client?.status === 'ready';
      });

      this.client.on('close', () => {
        this.isConnected = false;
        logger.info('[REDIS] Connection closed');
      });

      await this.client.connect();
    } catch {
      logger.warn('[REDIS] Failed to connect, using in-memory fallback');
      this.client = null;
      this.isConnected = false;
    }
  }

  async disconnect(): Promise<void> {
    if (this.client) {
      await this.client.quit();
      this.client = null;
      this.isConnected = false;
    }
  }

  isAvailable(): boolean {
    return this.isConnected && this.client !== null;
  }

  getClient(): Redis | null {
    return this.client;
  }

  /**
   * Returns the connected Redis client or throws if not connected.
   * Replaces non-null assertions (`this.getConnectedClient()`) with a proper runtime check.
   */
  private getConnectedClient(): Redis {
    if (!this.client) {
      throw new Error('Redis client is not connected');
    }
    return this.client;
  }

  // ==========================================
  // CSRF Token Management
  // ==========================================

  async setCsrfToken(sessionId: string, token: string, ttlSeconds = 3600): Promise<void> {
    if (!this.isAvailable()) return;
    await this.getConnectedClient().setex(`csrf:${sessionId}`, ttlSeconds, token);
  }

  async getCsrfToken(sessionId: string): Promise<string | null> {
    if (!this.isAvailable()) return null;
    return this.getConnectedClient().get(`csrf:${sessionId}`);
  }

  async deleteCsrfToken(sessionId: string): Promise<void> {
    if (!this.isAvailable()) return;
    await this.getConnectedClient().del(`csrf:${sessionId}`);
  }

  // ==========================================
  // Session Management
  // ==========================================

  async setSession(
    sessionId: string,
    data: Record<string, unknown>,
    ttlSeconds = 86400
  ): Promise<void> {
    if (!this.isAvailable()) return;
    await this.getConnectedClient().setex(`session:${sessionId}`, ttlSeconds, JSON.stringify(data));
  }

  async getSession(sessionId: string): Promise<Record<string, unknown> | null> {
    if (!this.isAvailable()) return null;
    const data = await this.getConnectedClient().get(`session:${sessionId}`);
    if (!data) return null;
    try {
      return JSON.parse(data);
    } catch {
      return null;
    }
  }

  async deleteSession(sessionId: string): Promise<void> {
    if (!this.isAvailable()) return;
    await this.getConnectedClient().del(`session:${sessionId}`);
  }

  async extendSession(sessionId: string, ttlSeconds = 86400): Promise<void> {
    if (!this.isAvailable()) return;
    await this.getConnectedClient().expire(`session:${sessionId}`, ttlSeconds);
  }

  // ==========================================
  // General Caching
  // ==========================================

  async set(key: string, value: string | object, ttlSeconds?: number): Promise<void> {
    if (!this.isAvailable()) return;
    const stringValue = typeof value === 'object' ? JSON.stringify(value) : value;
    if (ttlSeconds) {
      await this.getConnectedClient().setex(`cache:${key}`, ttlSeconds, stringValue);
    } else {
      await this.getConnectedClient().set(`cache:${key}`, stringValue);
    }
  }

  async get<T = string>(key: string, parseJson = false): Promise<T | null> {
    if (!this.isAvailable()) return null;
    const data = await this.getConnectedClient().get(`cache:${key}`);
    if (!data) return null;
    if (parseJson) {
      try {
        return JSON.parse(data);
      } catch {
        return null;
      }
    }
    return data as T;
  }

  async delete(key: string): Promise<void> {
    if (!this.isAvailable()) return;
    await this.getConnectedClient().del(`cache:${key}`);
  }

  async exists(key: string): Promise<boolean> {
    if (!this.isAvailable()) return false;
    return (await this.getConnectedClient().exists(`cache:${key}`)) === 1;
  }

  /**
   * Cache generation counters (`lib/public-cache.ts`, FIX-001). Kept OUT of
   * the `cache:` namespace on purpose: they are coordination state, not
   * payloads — on Workers that routes them to the strongly consistent AuthState
   * Durable Object (atomic INCR), never to eventually consistent KV. Throws when Redis is unavailable or any read fails — the caller
   * must then treat the shared layer as unverifiable and skip its fill.
   */
  async getCacheGenerations(names: string[]): Promise<Array<string | null>> {
    if (!this.isAvailable()) throw new Error('Redis unavailable');
    const client = this.getConnectedClient() as unknown;
    // Workers: one call per shard, replicated prefix names read with their store (PERF-RL-DO), never a global instance.
    if (client instanceof CfRedis) return client.cacheGenerations(names);
    const pipe = this.getConnectedClient().pipeline();
    for (const name of names) pipe.get(`cachegen:${name}`);
    const results = await pipe.exec();
    if (!results) throw new Error('Redis pipeline returned no results');
    return results.map(([err, value]) => {
      if (err) throw err;
      return (value as string | null) ?? null;
    });
  }

  /** Atomically bump one generation (INCR + refresh its TTL). Throws on failure. */
  async bumpCacheGeneration(name: string, ttlSeconds: number): Promise<void> {
    if (!this.isAvailable()) throw new Error('Redis unavailable');
    const client = this.getConnectedClient() as unknown;
    if (client instanceof CfRedis) return client.bumpCacheGeneration(name, ttlSeconds);
    const key = `cachegen:${name}`;
    const results = await this.getConnectedClient()
      .multi()
      .incr(key)
      .expire(key, ttlSeconds)
      .exec();
    const failed = results?.find(([err]) => err)?.[0];
    if (!results || failed) throw failed ?? new Error('Redis MULTI returned no results');
  }

  /**
   * Delete every cache entry whose logical key starts with `prefix`
   * (Redis key `cache:${prefix}*`). Uses a non-blocking SCAN cursor + UNLINK
   * so busting a store's product cache never stalls the event loop or blocks
   * other clients (unlike `KEYS`). Best-effort: a Redis outage returns 0 and
   * the caller's in-memory sweep still runs. Returns the number of keys removed.
   */
  async deleteByPattern(prefix: string): Promise<number> {
    if (!this.isAvailable()) return 0;
    const client = this.getConnectedClient();
    const match = `cache:${prefix}*`;
    let cursor = '0';
    let removed = 0;
    do {
      const [next, keys] = await client.scan(cursor, 'MATCH', match, 'COUNT', 200);
      cursor = next;
      if (keys.length > 0) {
        await client.unlink(...keys);
        removed += keys.length;
      }
    } while (cursor !== '0');
    return removed;
  }

  // ==========================================
  // Rate Limiting
  // ==========================================

  async incrementRateLimit(key: string, windowSeconds: number): Promise<number> {
    if (!this.isAvailable()) return 0;

    const redisKey = `ratelimit:${key}`;
    const multi = this.getConnectedClient().multi();
    multi.incr(redisKey);
    multi.expire(redisKey, windowSeconds);
    const results = await multi.exec();

    return (results?.[0]?.[1] as number) || 0;
  }

  /**
   * FIXED-window counter: the TTL is armed only when the key is created (count === 1) and is
   * never extended by later hits, dropped or not. (`incrementRateLimit` re-arms it on every call,
   * which lets a steady trickle hold a counter over its cap forever.) A key found without a TTL
   * (crash between INCR and EXPIRE) is repaired. Returns 0 when Redis is unavailable (fail-open).
   */
  async incrementFixedWindow(key: string, windowSeconds: number): Promise<number> {
    if (!this.isAvailable()) return 0;
    const client = this.getConnectedClient();
    const redisKey = `ratelimit:${key}`;
    const count = await client.incr(redisKey);
    if (count === 1 || (await client.ttl(redisKey)) === -1) {
      await client.expire(redisKey, windowSeconds);
    }
    return count;
  }

  async getRateLimitCount(key: string): Promise<number> {
    if (!this.isAvailable()) return 0;
    const count = await this.getConnectedClient().get(`ratelimit:${key}`);
    return count ? parseInt(count, 10) : 0;
  }

  // ==========================================
  // Distributed Locking
  // ==========================================

  async acquireLock(lockName: string, ttlSeconds = 30): Promise<boolean> {
    if (!this.isAvailable()) return true; // Allow operation if Redis unavailable

    const lockKey = `lock:${lockName}`;
    const result = await this.getConnectedClient().set(lockKey, '1', 'EX', ttlSeconds, 'NX');
    return result === 'OK';
  }

  async releaseLock(lockName: string): Promise<void> {
    if (!this.isAvailable()) return;
    await this.getConnectedClient().del(`lock:${lockName}`);
  }

  // ==========================================
  // Pub/Sub (for real-time features)
  // ==========================================

  async publish(channel: string, message: string | object): Promise<void> {
    if (!this.isAvailable()) return;
    const msg = typeof message === 'object' ? JSON.stringify(message) : message;
    await this.getConnectedClient().publish(channel, msg);
  }

  // ==========================================
  // JWT Revocation (JTI denylist + per-user token version)
  // ==========================================

  async denyJti(jti: string, ttlSeconds: number): Promise<void> {
    const c = this.getClient();
    if (!c) return; // fail-open
    await c.setex(`jti:deny:${jti}`, Math.max(1, Math.ceil(ttlSeconds)), '1');
  }

  async isJtiDenied(jti: string): Promise<boolean> {
    const c = this.getClient();
    if (!c) return false;
    return (await c.exists(`jti:deny:${jti}`)) === 1;
  }

  async setUserTokenVersion(userId: string, version: number): Promise<void> {
    const c = this.getClient();
    if (!c) return;
    await c.set(`user:tv:${userId}`, String(version));
  }

  /** Drop the cached tv so the next authenticate reads Postgres. */
  async clearUserTokenVersion(userId: string): Promise<void> {
    const c = this.getClient();
    if (!c) return;
    await c.del(`user:tv:${userId}`);
  }

  async getUserTokenVersion(userId: string): Promise<number | null> {
    const c = this.getClient();
    if (!c) return null;
    const v = await c.get(`user:tv:${userId}`);
    return v === null ? null : Number(v);
  }

  // ==========================================
  // MFA Verify — per-challenge attempt counter (H2)
  // Keyed by challenge token jti so each login attempt has its own limit.
  // ==========================================

  /**
   * Increment the failed-attempt counter for an MFA challenge.
   * Returns the new count. Fail-open: returns 0 if Redis is unavailable
   * (the upstream caller treats 0 as "no lockout yet").
   */
  async incrementMfaAttempt(jti: string, ttlSeconds: number): Promise<number> {
    const c = this.getClient();
    if (!c) return 0; // fail-open
    const key = `mfa:verify:attempts:${jti}`;
    const multi = c.multi();
    multi.incr(key);
    // Always refresh TTL so the window matches the challenge lifetime.
    multi.expire(key, ttlSeconds);
    const results = await multi.exec();
    return (results?.[0]?.[1] as number) ?? 0;
  }

  /**
   * Immediately invalidate an MFA challenge by setting its attempt counter
   * to a value above the max. Used after a lockout to prevent replay.
   */
  async lockMfaChallenge(jti: string, ttlSeconds: number): Promise<void> {
    const c = this.getClient();
    if (!c) return;
    // Set to a sentinel value well above any reasonable max to ensure the
    // key is present and the next read sees it as locked.
    await c.setex(`mfa:verify:attempts:${jti}`, ttlSeconds, '999');
  }

  /**
   * Check current MFA attempt count for a challenge jti.
   * Returns 0 if Redis is unavailable (fail-open).
   */
  async getMfaAttempts(jti: string): Promise<number> {
    const c = this.getClient();
    if (!c) return 0;
    const v = await c.get(`mfa:verify:attempts:${jti}`);
    return v === null ? 0 : Number(v);
  }

  // ==========================================
  // Health Check
  // ==========================================

  async ping(): Promise<boolean> {
    if (!this.isAvailable()) return false;
    try {
      const result = await this.getConnectedClient().ping();
      return result === 'PONG';
    } catch {
      return false;
    }
  }
}

// Singleton instance
export const redis = new RedisService();
