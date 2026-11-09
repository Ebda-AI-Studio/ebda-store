/**
 * PERF-RL-DO (Ruling PERF-RL-DO-1): public limiter hits are prefetched in one batched call per shard, a limiter takes its
 * prefetched result, an unconsumed hit is taken back, and a wrong / failed prediction falls back to the direct call (so a
 * prediction can only cost time, never a count). Cache generations: one call per instance, replicated names bumped everywhere.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  calls: [] as Array<{ shard: number; ops: unknown[][] }>,
  fail: false,
  // counters a `get` answers with (a key not listed answers the shard marker the cachegen cases read)
  counters: new Map<string, unknown>(),
  pttl: 1 as number,
}));
vi.mock('../../apps/api/src/cf/auth-state-client', async orig => {
  const real = await orig<typeof import('../../apps/api/src/cf/auth-state-client')>();
  const run = async (shard: number, ops: unknown[][]) => {
    h.calls.push({ shard, ops });
    if (h.fail) throw new Error('do down');
    return ops.map(op =>
      op[0] === 'hit'
        ? [7, 1_000_000]
        : op[0] === 'get'
          ? h.counters.has(String(op[1]))
            ? h.counters.get(String(op[1]))
            : `v:${shard}:${String(op[1])}`
          : op[0] === 'pttl'
            ? h.pttl
            : 1
    );
  };
  return {
    ...real,
    applyOn: (key: string, ops: unknown[][]) => run(real.shardOf(key), ops),
    applyOnShard: (shard: number, ops: unknown[][]) => run(shard, ops),
  };
});
import {
  CfRateLimitStore,
  prefetchHits,
  releaseUnconsumed,
  runWithPrefetchedHits,
} from '../../apps/api/src/cf/rate-limit-store';
import { CfRedis } from '../../apps/api/src/cf/ioredis-cf';
import { runWithWaitUntil } from '../../apps/api/src/cf/bindings';
import {
  shardOf,
  CACHEGEN_SHARD,
  CACHEGEN_STORE_SHARDS,
} from '../../apps/api/src/cf/auth-state-client';

const W = 60_000;
const store = (name: string) => {
  const s = new CfRateLimitStore(`rl:${name}:`);
  s.init({ windowMs: W } as never);
  return s;
};

beforeEach(() => {
  h.calls.length = 0;
  h.fail = false;
  h.counters.clear();
  h.pttl = 1;
});

describe('public limiter prefetch', () => {
  it('one client’s public-family keys share a shard, so the batch is ONE call', () => {
    const ip = '203.0.113.9';
    const shards = new Set(
      ['public', 'public-tenant', 'store-miss', 'public-search'].map(p => shardOf(`rl:${p}:${ip}`))
    );
    expect(shards.size).toBe(1);
    // auth limiters are untouched: still keyed by their own full key
    expect(shardOf(`rl:auth:${ip}`)).not.toBeUndefined();
    prefetchHits([
      { key: `rl:public:${ip}`, windowMs: W },
      { key: `rl:store-miss:${ip}`, windowMs: W },
      { key: `rl:public-search:${ip}`, windowMs: W },
    ]);
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0].ops.map(o => o[0])).toEqual(['hit', 'hit', 'hit']);
  });

  it('a limiter takes its prefetched hit (no second call); the unconsumed one is taken back once', async () => {
    const ip = '198.51.100.1';
    const hits = prefetchHits([
      { key: `rl:public:${ip}`, windowMs: W },
      { key: `rl:store-miss:${ip}`, windowMs: W },
    ]);
    const info = await runWithPrefetchedHits(hits, () => store('public').increment(ip));
    expect(info.totalHits).toBe(7);
    expect(h.calls).toHaveLength(1);
    await releaseUnconsumed(hits);
    await releaseUnconsumed(hits);
    expect(h.calls).toHaveLength(2);
    expect(h.calls[1].ops).toEqual([['unhit', `rl:store-miss:${ip}`]]);
  });

  it('a key the prefetch did not predict is counted directly', async () => {
    const hits = prefetchHits([{ key: 'rl:public:1.1.1.1', windowMs: W }]);
    await runWithPrefetchedHits(hits, () => store('public').increment('2.2.2.2'));
    expect(h.calls).toHaveLength(2);
    expect(h.calls[1].ops).toEqual([['hit', 'rl:public:2.2.2.2', W]]);
  });

  it('a failed prefetch falls back to the direct call, and nothing is "taken back" for it', async () => {
    h.fail = true;
    const hits = prefetchHits([
      { key: 'rl:public:3.3.3.3', windowMs: W },
      { key: 'rl:store-miss:3.3.3.3', windowMs: W },
    ]);
    h.fail = false;
    const info = await runWithPrefetchedHits(hits, () => store('public').increment('3.3.3.3'));
    expect(info.totalHits).toBe(7);
    expect(h.calls).toHaveLength(2);
    await releaseUnconsumed(hits);
    expect(h.calls).toHaveLength(2);
  });

  it('outside a prefetch scope the store behaves exactly as before', async () => {
    await store('store-miss').increment('4.4.4.4');
    expect(h.calls).toEqual([
      { shard: shardOf('rl:store-miss:4.4.4.4'), ops: [['hit', 'rl:store-miss:4.4.4.4', W]] },
    ]);
  });
});

// LAUNCH-RL-MISS (Ruling LAUNCH-RL-MISS-1): the store-miss limiter reads its counter before the handler and counts after a
// 404, so its key rides the batch as a READ. A read is never a hit: nothing to take, nothing to give back.
describe('a peek rides the prefetch batch (store-miss)', () => {
  const ip = '203.0.113.40';
  const miss = `rl:store-miss:${ip}`;
  it('is read with `get` + `pttl` after the hits, in the same ONE call', () => {
    prefetchHits([{ key: `rl:public:${ip}`, windowMs: W }], [miss]);
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0].ops).toEqual([
      ['hit', `rl:public:${ip}`, W],
      ['get', miss],
      ['pttl', miss],
    ]);
  });
  it('a request with no hit to prefetch (native fast path) still reads the counter in one call', () => {
    prefetchHits([], [miss]);
    expect(h.calls).toEqual([
      {
        shard: shardOf(miss),
        ops: [
          ['get', miss],
          ['pttl', miss],
        ],
      },
    ]);
  });
  it('the limiter’s `get` takes the batched read (no second call): count and the open window', async () => {
    h.counters.set(miss, 5);
    h.pttl = 30_000;
    const hits = prefetchHits([{ key: `rl:public:${ip}`, windowMs: W }], [miss]);
    const before = Date.now();
    const info = await runWithPrefetchedHits(hits, () => store('store-miss').get(ip));
    expect(info?.totalHits).toBe(5);
    expect(info!.resetTime!.getTime()).toBeGreaterThanOrEqual(before + 30_000);
    expect(info!.resetTime!.getTime()).toBeLessThanOrEqual(Date.now() + 30_000);
    expect(h.calls).toHaveLength(1);
  });
  it('no counter yet reads as nothing counted', async () => {
    h.counters.set(miss, null);
    h.pttl = -2;
    const hits = prefetchHits([], [miss]);
    expect(await runWithPrefetchedHits(hits, () => store('store-miss').get(ip))).toBeUndefined();
    expect(h.calls).toHaveLength(1);
  });
  it('is never taken as a hit and never given back', async () => {
    h.counters.set(miss, 5);
    const hits = prefetchHits([{ key: `rl:public:${ip}`, windowMs: W }], [miss]);
    await runWithPrefetchedHits(hits, async () => {
      await store('public').increment(ip);
      // counting the miss (after a 404) is its own hit, not the batched read
      await store('store-miss').increment(ip);
    });
    expect(h.calls).toHaveLength(2);
    expect(h.calls[1].ops).toEqual([['hit', miss, W]]);
    await releaseUnconsumed(hits);
    expect(h.calls).toHaveLength(2);
  });
  it('a failed batch falls back to a direct read', async () => {
    h.fail = true;
    const hits = prefetchHits([], [miss]);
    h.fail = false;
    h.counters.set(miss, 9);
    h.pttl = 1_000;
    const info = await runWithPrefetchedHits(hits, () => store('store-miss').get(ip));
    expect(info?.totalHits).toBe(9);
    expect(h.calls).toHaveLength(2);
    expect(h.calls[1].ops).toEqual([
      ['get', miss],
      ['pttl', miss],
    ]);
  });
});

// LAUNCH-RL-MISS: express-rate-limit calls `decrement` AFTER the response and does not wait for it. On a Worker that call
// must be handed to `waitUntil`, or the runtime may drop it with the request and a success stays counted as a failure.
describe('the give-back of a failures-only limiter outlives the response', () => {
  it('`decrement` hands its Durable Object call to waitUntil', async () => {
    const kept: Array<Promise<unknown>> = [];
    await runWithWaitUntil(
      p => kept.push(p),
      () => store('auth-ip-fail').decrement('198.51.100.60')
    );
    expect(h.calls).toEqual([
      {
        shard: shardOf('rl:auth-ip-fail:198.51.100.60'),
        ops: [['unhit', 'rl:auth-ip-fail:198.51.100.60']],
      },
    ]);
    expect(kept).toHaveLength(1);
    await expect(kept[0]).resolves.not.toThrow();
  });
  it('a failed give-back never rejects (nothing awaits it after the response)', async () => {
    h.fail = true;
    const kept: Array<Promise<unknown>> = [];
    await expect(
      runWithWaitUntil(
        p => kept.push(p),
        () => store('auth-ip-fail').decrement('198.51.100.61')
      )
    ).resolves.toBeUndefined();
    expect(kept).toHaveLength(1);
    await expect(kept[0]).resolves.toBeUndefined();
  });
});

describe('cache generations (no global instance)', () => {
  const S = '11111111-1111-4111-8111-111111111111';
  it('a store fill reads root, prefixes and its own names in ONE call on the store shard', async () => {
    const names = [
      '',
      'public:',
      'public:products:',
      `public:products:${S}:`,
      `public:products:${S}:x`,
    ];
    const out = await new CfRedis().cacheGenerations(names);
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0].shard).toBeLessThan(CACHEGEN_SHARD);
    expect(out).toHaveLength(names.length);
    expect(out[0]).toBe(`v:${h.calls[0].shard}:cachegen:`);
  });
  it('a key-prefixed client keeps its prefix', async () => {
    await new CfRedis({ keyPrefix: 'stg:' }).cacheGenerations(['public:']);
    expect(h.calls[0].ops).toEqual([['get', 'stg:cachegen:public:']]);
  });
  it('a store name bumps one shard; a replicated name bumps every store shard', async () => {
    const c = new CfRedis();
    await c.bumpCacheGeneration(`public:products:${S}:`, 10);
    expect(h.calls).toHaveLength(1);
    h.calls.length = 0;
    await c.bumpCacheGeneration('public:', 10);
    expect(new Set(h.calls.map(x => x.shard)).size).toBe(CACHEGEN_STORE_SHARDS);
    expect(h.calls[0].ops).toEqual([
      ['incr', 'cachegen:public:'],
      ['expire', 'cachegen:public:', 10_000],
    ]);
  });
});
