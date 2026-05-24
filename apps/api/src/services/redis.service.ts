import Redis from 'ioredis';
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
      this.client = new Redis(config.redisUrl, {
        maxRetriesPerRequest: 3,
        retryStrategy(times: number) {
          return Math.min(times * 500, 30000);
        },
        lazyConnect: true,
        // When REDIS_KEY_PREFIX is set (e.g. `fwb-staging:` on staging),
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

      this.client.on('error', (err: Error) => {
        logger.error({ err: err.message }, '[REDIS] Connection error');
        this.isConnected = false;
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
