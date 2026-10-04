/**
 * express-rate-limit `Store` on the AuthState Durable Object.
 *
 * Fixed-window counters, exact and shared by every isolate (the Redis store's job on
 * Node). Used for all 24 limiters, which matters most for the auth ones (5 / 15 min
 * per IP + email): approximate, per-location counting would let a distributed guesser
 * through. A store error propagates, and every limiter sets `passOnStoreError`, so an
 * outage fails OPEN exactly as the Redis store did.
 *
 * Deliberately has no timers: a MemoryStore starts a `setInterval` at init, which
 * workerd forbids in global scope and which an isolate would not honour anyway.
 */
import type { Options, Store, ClientRateLimitInfo } from 'express-rate-limit';
import { applyOn } from './auth-state-client';

export class CfRateLimitStore implements Store {
  readonly localKeys = false;
  private windowMs = 60_000;

  constructor(readonly prefix: string) {}

  init(options: Options): void {
    this.windowMs = options.windowMs;
  }

  private k(key: string): string {
    return `${this.prefix}${key}`;
  }

  async get(key: string): Promise<ClientRateLimitInfo | undefined> {
    const redisKey = this.k(key);
    const [value, pttl] = (await applyOn(redisKey, [
      ['get', redisKey],
      ['pttl', redisKey],
    ])) as [string | null, number];
    if (value === null) return undefined;
    return { totalHits: Number(value), resetTime: new Date(Date.now() + Math.max(0, pttl)) };
  }

  async increment(key: string): Promise<ClientRateLimitInfo> {
    const redisKey = this.k(key);
    const [res] = (await applyOn(redisKey, [['hit', redisKey, this.windowMs]])) as [
      [number, number],
    ];
    return { totalHits: res[0], resetTime: new Date(res[1]) };
  }

  async decrement(key: string): Promise<void> {
    const redisKey = this.k(key);
    await applyOn(redisKey, [['unhit', redisKey]]);
  }

  async resetKey(key: string): Promise<void> {
    const redisKey = this.k(key);
    await applyOn(redisKey, [['del', redisKey]]);
  }
}
