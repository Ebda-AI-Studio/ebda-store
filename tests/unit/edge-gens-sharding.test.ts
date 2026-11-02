/**
 * Ruling NZ-D3: store-scoped cache generations are sharded per store (no single hot Durable Object) and edge-hit validation is
 * memoised per isolate for 2 s. The memo is dropped by a bump in the same isolate; an unverifiable answer is never remembered.
 */
import { describe, it, expect, vi } from 'vitest';
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
    const read = vi.fn(async () => '1,2,3');
    for (let i = 0; i < 1000; i++) await memoisedGens(['a', 'b'], read, 10_000 + i);
    expect(read).toHaveBeenCalledTimes(1);
    await memoisedGens(['a', 'b'], read, 10_000 + EDGE_GENS_MEMO_MS + 1);
    expect(read).toHaveBeenCalledTimes(2);
  });
  it('a bump in this isolate drops the memo at once', async () => {
    dropEdgeGensMemo();
    const read = vi.fn(async () => 'g');
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
      .mockResolvedValue('ok');
    expect(await memoisedGens(['a'], read, 1)).toBeNull();
    await Promise.resolve();
    expect(await memoisedGens(['a'], read, 2)).toBe('ok');
    expect(read).toHaveBeenCalledTimes(2);
  });
  it('different name sets do not share a slot', async () => {
    dropEdgeGensMemo();
    const read = vi.fn(async (n: string[]) => n.join('+'));
    expect(await memoisedGens(['a'], read, 1)).toBe('a');
    expect(await memoisedGens(['b'], read, 1)).toBe('b');
  });
});
