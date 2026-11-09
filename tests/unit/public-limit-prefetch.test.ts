/**
 * PERF-RL-DO (Ruling PERF-RL-DO-1): public limiter hits are prefetched in one batched call per shard, a limiter takes its
 * prefetched result, an unconsumed hit is taken back, and a wrong / failed prediction falls back to the direct call (so a
 * prediction can only cost time, never a count). Cache generations: one call per instance, replicated names bumped everywhere.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  calls: [] as Array<{ shard: number; ops: unknown[][] }>,
  fail: false,
}));
vi.mock('../../apps/api/src/cf/auth-state-client', async orig => {
  const real = await orig<typeof import('../../apps/api/src/cf/auth-state-client')>();
  const run = async (shard: number, ops: unknown[][]) => {
    h.calls.push({ shard, ops });
    if (h.fail) throw new Error('do down');
    return ops.map(op =>
      op[0] === 'hit' ? [7, 1_000_000] : op[0] === 'get' ? `v:${shard}:${String(op[1])}` : 1
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
