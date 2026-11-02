/**
 * Ruling NZ-D3: store-scoped cache generations are sharded per store (no single hot Durable Object) and edge-hit validation is
 * memoised per isolate for 2 s. The memo is dropped by a bump in the same isolate; an unverifiable answer is never remembered.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  gens: new Map<string, string>(),
  reads: [] as string[][],
  bumpGate: null as null | Promise<void>,
}));
vi.mock('../../apps/api/src/services/redis.service', () => ({
  redis: {
    isAvailable: () => true,
    getCacheGenerations: async (names: string[]) => {
      h.reads.push(names);
      return names.map(n => h.gens.get(n) ?? null);
    },
    bumpCacheGeneration: async (name: string) => {
      if (h.bumpGate) await h.bumpGate;
      h.gens.set(name, String(Number(h.gens.get(name) ?? 0) + 1));
    },
    get: async () => null,
    set: async () => undefined,
    delete: async () => undefined,
    deleteByPattern: async () => 0,
  },
}));
import {
  shardOf,
  CACHEGEN_SHARD,
  CACHEGEN_STORE_SHARDS,
} from '../../apps/api/src/cf/auth-state-client';
import {
  memoisedGens,
  dropEdgeGensMemo,
  EDGE_GENS_MEMO_MS,
} from '../../apps/api/src/lib/edge-gens-memo';

const S1 = '11111111-1111-4111-8111-111111111111';
const S2 = '9a8b7c6d-1234-4abc-8def-0123456789ab';

describe('cachegen sharding', () => {
  it('names without a store id stay on the base instance', () => {
    for (const n of ['cachegen:', 'cachegen:public:', 'cachegen:public:products:'])
      expect(shardOf(n)).toBe(CACHEGEN_SHARD);
  });
  it('every name of one store lands on the same store shard, below the base shard', () => {
    const a = shardOf(`cachegen:public:products:${S1}:`);
    expect(a).toBeLessThan(CACHEGEN_SHARD);
    expect(shardOf(`cachegen:public:categories:${S1}`)).toBe(a);
    expect(shardOf(`cachegen:public:store:resolve:${S1}`)).toBe(a);
  });
  it('stores spread over all shards and stay in range', () => {
    const seen = new Set<number>();
    for (let i = 0; i < 4000; i++) {
      const id = `${i.toString(16).padStart(8, '0')}-0000-4000-8000-000000000000`;
      const s = shardOf(`cachegen:public:products:${id}:`);
      expect(s).toBeLessThanOrEqual(-2);
      expect(s).toBeGreaterThanOrEqual(-1 - CACHEGEN_STORE_SHARDS);
      seen.add(s);
    }
    expect(seen.size).toBe(CACHEGEN_STORE_SHARDS);
    expect(shardOf(`cachegen:x:${S2}`)).not.toBe(CACHEGEN_SHARD);
  });
  it('auth keys are untouched', () => {
    expect(shardOf('jti:abc')).toBeGreaterThanOrEqual(0);
  });
});

describe('edge-hit generation memo', () => {
  it('1000 hits inside the window cost one read; a new window reads again', async () => {
    dropEdgeGensMemo();
    const read = vi.fn(async () => ['1', '2', '3']);
    for (let i = 0; i < 1000; i++) await memoisedGens(['a', 'b'], read, 10_000 + i);
    expect(read).toHaveBeenCalledTimes(1);
    await memoisedGens(['a', 'b'], read, 10_000 + EDGE_GENS_MEMO_MS + 1);
    expect(read).toHaveBeenCalledTimes(2);
  });
  it('a bump in this isolate drops the memo at once', async () => {
    dropEdgeGensMemo();
    const read = vi.fn(async () => ['g']);
    await memoisedGens(['a'], read, 1);
    dropEdgeGensMemo();
    await memoisedGens(['a'], read, 2);
    expect(read).toHaveBeenCalledTimes(2);
  });
  it('an unverifiable answer (null) or a throw is never remembered', async () => {
    dropEdgeGensMemo();
    const read = vi
      .fn<(n: string[]) => Promise<string | null>>()
      .mockResolvedValueOnce(null)
      .mockResolvedValue(['ok']);
    expect(await memoisedGens(['a'], read, 1)).toBeNull();
    await Promise.resolve();
    expect(await memoisedGens(['a'], read, 2)).toEqual(['ok']);
    expect(read).toHaveBeenCalledTimes(2);
  });
  it('different name sets do not share a slot', async () => {
    dropEdgeGensMemo();
    const read = vi.fn(async (n: string[]) => [n.join('+')]);
    expect(await memoisedGens(['a'], read, 1)).toEqual(['a']);
    expect(await memoisedGens(['b'], read, 1)).toEqual(['b']);
  });
});

import {
  readEdgeGens,
  readEdgeGensForHit,
  EDGE_STAMP_EPOCH,
} from '../../apps/api/src/lib/edge-gens';
import { invalidateCachedPrefix } from '../../apps/api/src/lib/public-cache';

describe('security review fixes (ABA epoch, bump race, status never memoised)', () => {
  beforeEach(() => {
    h.gens.clear();
    h.reads.length = 0;
    h.bumpGate = null;
    dropEdgeGensMemo();
  });
  const NAMES = ['public:', `public:products:${S1}:`, 'public:store:resolve:amelia.ebda.app'];

  it('an entry stamped under the OLD (pre-shard) layout is a miss under the new one', async () => {
    // an old stamp was the bare joined counters; the new layout counters restart at 0, which is the SAME bare string
    const oldStamp = '0,0,0';
    const now = await readEdgeGens(NAMES);
    expect(now).toBe(EDGE_STAMP_EPOCH + '0,0,0');
    expect(now).not.toBe(oldStamp);
  });
  it('the status generation is read fresh on every hit; the others are memoised', async () => {
    for (let i = 0; i < 20; i++) await readEdgeGensForHit(NAMES);
    const statusReads = h.reads.filter(r => r.includes('public:store:resolve:amelia.ebda.app'));
    const otherReads = h.reads.filter(r => r.includes('public:'));
    expect(statusReads).toHaveLength(20);
    expect(
      otherReads.filter(r => !r.some(n => n.startsWith('public:store:resolve:')))
    ).toHaveLength(1);
  });
  it('the status generation of a host has its own shard, never the base instance', () => {
    expect(shardOf('cachegen:public:store:resolve:amelia.ebda.app')).toBeLessThan(CACHEGEN_SHARD);
  });
  it('a read racing a bump never returns the pre-bump generation once the bump resolved', async () => {
    h.gens.set(NAMES[1], '1');
    await readEdgeGensForHit(NAMES); // warm the memo with the OLD generation
    let release!: () => void;
    h.bumpGate = new Promise<void>(r => (release = r));
    const bump = invalidateCachedPrefix(`public:products:${S1}:`);
    await Promise.resolve();
    const during = await readEdgeGensForHit(NAMES); // re-memoises the old value while the bump is pending
    expect(during).toContain('1');
    h.bumpGate = null;
    release();
    await bump;
    const after = await readEdgeGensForHit(NAMES);
    expect(after).not.toBe(during);
  });
});
