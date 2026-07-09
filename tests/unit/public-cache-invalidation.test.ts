/**
 * public-cache — Builder Reality Audit (Lens A) fixes.
 *
 * Covers:
 *  - A3: getCached() single-flight (concurrent misses share one fetchFn call).
 *  - A2: invalidateCachedPrefix / invalidateStoreProductCaches now clear the
 *        Redis layer via redis.deleteByPattern (not just the in-memory mirror),
 *        and stay best-effort when Redis throws.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// vi.mock is hoisted above module scope, so the mock object must be created via
// vi.hoisted() to be available inside the (also-hoisted) factory.
const redisMock = vi.hoisted(() => ({
  get: vi.fn(async () => null as unknown),
  set: vi.fn(async () => {}),
  delete: vi.fn(async () => {}),
  deleteByPattern: vi.fn(async () => 0),
}));

vi.mock('../../apps/api/src/services/redis.service', () => ({
  redis: redisMock,
}));

import {
  getCached,
  invalidateCachedPrefix,
  invalidateStoreProductCaches,
} from '../../apps/api/src/lib/public-cache';

beforeEach(() => {
  vi.clearAllMocks();
  redisMock.get.mockResolvedValue(null);
  redisMock.deleteByPattern.mockResolvedValue(0);
});

describe('getCached() single-flight (A3 stampede protection)', () => {
  it('collapses concurrent misses on the same key into ONE fetchFn call', async () => {
    let calls = 0;
    const fetchFn = vi.fn(async () => {
      calls += 1;
      await new Promise(resolve => setTimeout(resolve, 10));
      return { value: calls };
    });

    const results = await Promise.all([
      getCached('k:herd', 60, fetchFn),
      getCached('k:herd', 60, fetchFn),
      getCached('k:herd', 60, fetchFn),
      getCached('k:herd', 60, fetchFn),
    ]);

    expect(fetchFn).toHaveBeenCalledTimes(1);
    // Every concurrent caller gets the same single-flight result.
    for (const r of results) expect(r).toEqual({ value: 1 });
  });

  it('does not coalesce across DIFFERENT keys', async () => {
    const fetchA = vi.fn(async () => 'a');
    const fetchB = vi.fn(async () => 'b');
    const [a, b] = await Promise.all([getCached('k:a', 60, fetchA), getCached('k:b', 60, fetchB)]);
    expect(a).toBe('a');
    expect(b).toBe('b');
    expect(fetchA).toHaveBeenCalledTimes(1);
    expect(fetchB).toHaveBeenCalledTimes(1);
  });
});

describe('invalidateStoreProductCaches() (A2 Redis-layer bust)', () => {
  it('busts the product LIST, DETAIL, and SUGGEST Redis prefixes', async () => {
    await invalidateStoreProductCaches('store123');
    const patterns = redisMock.deleteByPattern.mock.calls.map(c => c[0]);
    expect(patterns).toContain('public:products:store123:');
    expect(patterns).toContain('public:product:store123:');
    expect(patterns).toContain('public:suggest:store123:');
  });
});

describe('invalidateCachedPrefix() (A2)', () => {
  it('deletes the matching Redis pattern (not just in-memory)', async () => {
    await invalidateCachedPrefix('public:products:s1:');
    expect(redisMock.deleteByPattern).toHaveBeenCalledWith('public:products:s1:');
  });

  it('is best-effort — resolves even when Redis throws', async () => {
    redisMock.deleteByPattern.mockRejectedValueOnce(new Error('redis down'));
    await expect(invalidateCachedPrefix('public:products:s1:')).resolves.toBeUndefined();
  });
});
