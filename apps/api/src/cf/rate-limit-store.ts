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
import { AsyncLocalStorage } from 'node:async_hooks';
import type { Options, Store, ClientRateLimitInfo } from 'express-rate-limit';
import { applyOn, shardOf } from './auth-state-client';
import type { Op } from './auth-state-core';

/**
 * PERF-RL-DO: rate-limit hits issued AHEAD of the limiters, in one batched call per shard.
 *
 * The public router's limiters are separate express-rate-limit middlewares run one after another, so each one's counter was
 * its own serial Durable Object round trip (3-4 per public request, measured 2026-11-09). `prefetchHits` sends every hit a
 * request is about to make at once (the public family co-locates on the client's shard, auth-state-client `shardKey`); a
 * limiter's `increment` then takes its prefetched result instead of calling out. The limiters themselves are unchanged:
 * same keys, limits, windows, headers, 429 bodies, skips and decrements.
 *
 * A prediction can only cost time, never a count: a limiter that finds no prefetched hit calls the DO itself as before, and a
 * prefetched hit no limiter took (a skipped limiter, an earlier 429) is taken back with `unhit` when the response ends
 * ({@link releaseUnconsumed}). A failed prefetch falls back to the direct call.
 */
interface Prefetched {
  windowMs: number;
  result: Promise<[number, number]>;
  consumed: boolean;
  landed: boolean;
}
export type PrefetchedHits = Map<string, Prefetched>;
const prefetched = new AsyncLocalStorage<PrefetchedHits>();

export function prefetchHits(entries: Array<{ key: string; windowMs: number }>): PrefetchedHits {
  const map: PrefetchedHits = new Map();
  const byShard = new Map<number, Array<{ key: string; windowMs: number }>>();
  const seen = new Set<string>();
  for (const e of entries) {
    if (seen.has(e.key)) continue;
    seen.add(e.key);
    const list = byShard.get(shardOf(e.key)) ?? [];
    list.push(e);
    byShard.set(shardOf(e.key), list);
  }
  for (const list of byShard.values()) {
    const call = applyOn(
      list[0].key,
      list.map(e => ['hit', e.key, e.windowMs] as Op)
    );
    list.forEach((e, j) => {
      const entry: Prefetched = {
        windowMs: e.windowMs,
        consumed: false,
        landed: false,
        result: call.then(out => {
          entry.landed = true;
          return out[j] as [number, number];
        }),
      };
      entry.result.catch(() => undefined);
      map.set(e.key, entry);
    });
  }
  return map;
}

export function runWithPrefetchedHits<T>(hits: PrefetchedHits, fn: () => T): T {
  return prefetched.run(hits, fn);
}

/** Take back every prefetched hit no limiter consumed (once it has landed). One call per shard; never throws. */
export async function releaseUnconsumed(hits: PrefetchedHits): Promise<unknown> {
  const left = [...hits].filter(([, e]) => !e.consumed);
  for (const [, e] of left) e.consumed = true;
  await Promise.allSettled(left.map(([, e]) => e.result));
  const byShard = new Map<number, string[]>();
  for (const [key, e] of left) {
    if (!e.landed) continue;
    const list = byShard.get(shardOf(key)) ?? [];
    list.push(key);
    byShard.set(shardOf(key), list);
  }
  return Promise.all(
    [...byShard.values()].map(keys =>
      applyOn(
        keys[0],
        keys.map(k => ['unhit', k] as Op)
      ).catch(() => undefined)
    )
  );
}

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
    const pre = prefetched.getStore()?.get(redisKey);
    if (pre && !pre.consumed && pre.windowMs === this.windowMs) {
      pre.consumed = true;
      try {
        const [hits, resetAt] = await pre.result;
        return { totalHits: hits, resetTime: new Date(resetAt) };
      } catch {
        // the batched call failed: count directly below (a store error there fails open as before)
      }
    }
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
