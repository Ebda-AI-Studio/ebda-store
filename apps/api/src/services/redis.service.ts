import Redis from 'ioredis';
import { config } from '../config';

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
          if (times > 3) {
            console.warn('[REDIS] Max retries reached, falling back to in-memory');
            return null;
          }
          return Math.min(times * 100, 3000);
        },
        lazyConnect: true,
      });

      this.client.on('connect', () => {
        this.isConnected = true;
        console.log('[REDIS] Connected successfully');
      });

      this.client.on('error', (err: Error) => {
        console.error('[REDIS] Connection error:', err.message);
        this.isConnected = false;
      });

      this.client.on('close', () => {
        this.isConnected = false;
        console.log('[REDIS] Connection closed');
      });

      await this.client.connect();
    } catch {
      console.warn('[REDIS] Failed to connect, using in-memory fallback');
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

  // ==========================================
  // CSRF Token Management
  // ==========================================

  async setCsrfToken(sessionId: string, token: string, ttlSeconds = 3600): Promise<void> {
    if (!this.isAvailable()) return;
    await this.client!.setex(`csrf:${sessionId}`, ttlSeconds, token);
  }

  async getCsrfToken(sessionId: string): Promise<string | null> {
    if (!this.isAvailable()) return null;
    return this.client!.get(`csrf:${sessionId}`);
  }

  async deleteCsrfToken(sessionId: string): Promise<void> {
    if (!this.isAvailable()) return;
    await this.client!.del(`csrf:${sessionId}`);
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
    await this.client!.setex(`session:${sessionId}`, ttlSeconds, JSON.stringify(data));
  }

  async getSession(sessionId: string): Promise<Record<string, unknown> | null> {
    if (!this.isAvailable()) return null;
    const data = await this.client!.get(`session:${sessionId}`);
    if (!data) return null;
    try {
      return JSON.parse(data);
    } catch {
      return null;
    }
  }

  async deleteSession(sessionId: string): Promise<void> {
    if (!this.isAvailable()) return;
    await this.client!.del(`session:${sessionId}`);
  }

  async extendSession(sessionId: string, ttlSeconds = 86400): Promise<void> {
    if (!this.isAvailable()) return;
    await this.client!.expire(`session:${sessionId}`, ttlSeconds);
  }

  // ==========================================
  // General Caching
  // ==========================================

  async set(key: string, value: string | object, ttlSeconds?: number): Promise<void> {
    if (!this.isAvailable()) return;
    const stringValue = typeof value === 'object' ? JSON.stringify(value) : value;
    if (ttlSeconds) {
      await this.client!.setex(`cache:${key}`, ttlSeconds, stringValue);
    } else {
      await this.client!.set(`cache:${key}`, stringValue);
    }
  }

  async get<T = string>(key: string, parseJson = false): Promise<T | null> {
    if (!this.isAvailable()) return null;
    const data = await this.client!.get(`cache:${key}`);
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
    await this.client!.del(`cache:${key}`);
  }

  async exists(key: string): Promise<boolean> {
    if (!this.isAvailable()) return false;
    return (await this.client!.exists(`cache:${key}`)) === 1;
  }

  // ==========================================
  // Rate Limiting
  // ==========================================

  async incrementRateLimit(key: string, windowSeconds: number): Promise<number> {
    if (!this.isAvailable()) return 0;

    const redisKey = `ratelimit:${key}`;
    const multi = this.client!.multi();
    multi.incr(redisKey);
    multi.expire(redisKey, windowSeconds);
    const results = await multi.exec();

    return (results?.[0]?.[1] as number) || 0;
  }

  async getRateLimitCount(key: string): Promise<number> {
    if (!this.isAvailable()) return 0;
    const count = await this.client!.get(`ratelimit:${key}`);
    return count ? parseInt(count, 10) : 0;
  }

  // ==========================================
  // Distributed Locking
  // ==========================================

  async acquireLock(lockName: string, ttlSeconds = 30): Promise<boolean> {
    if (!this.isAvailable()) return true; // Allow operation if Redis unavailable

    const lockKey = `lock:${lockName}`;
    const result = await this.client!.set(lockKey, '1', 'EX', ttlSeconds, 'NX');
    return result === 'OK';
  }

  async releaseLock(lockName: string): Promise<void> {
    if (!this.isAvailable()) return;
    await this.client!.del(`lock:${lockName}`);
  }

  // ==========================================
  // Pub/Sub (for real-time features)
  // ==========================================

  async publish(channel: string, message: string | object): Promise<void> {
    if (!this.isAvailable()) return;
    const msg = typeof message === 'object' ? JSON.stringify(message) : message;
    await this.client!.publish(channel, msg);
  }

  // ==========================================
  // Health Check
  // ==========================================

  async ping(): Promise<boolean> {
    if (!this.isAvailable()) return false;
    try {
      const result = await this.client!.ping();
      return result === 'PONG';
    } catch {
      return false;
    }
  }
}

// Singleton instance
export const redis = new RedisService();
