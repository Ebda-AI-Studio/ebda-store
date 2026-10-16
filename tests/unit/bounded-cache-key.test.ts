/** Task 12 review M7: long cache keys are hashed under their readable prefix (Workers KV 512 B). */
import { describe, it, expect, vi } from 'vitest';

vi.mock('../../apps/api/src/services/redis.service', () => ({
  redis: { isAvailable: () => false, getClient: () => null },
}));
const { boundedCacheKey, CACHE_KEY_MAX_BYTES } =
  await import('../../apps/api/src/lib/public-cache');

describe('boundedCacheKey', () => {
  const P = 'public:products:11111111-1111-4111-8111-111111111111:';
  it('keeps a short key as is', () => {
    expect(boundedCacheKey(P, '{"search":"shoes"}')).toBe(`${P}{"search":"shoes"}`);
  });
  it('hashes a long key under the same prefix, deterministic and distinct', () => {
    const long = JSON.stringify({ search: 'حذاء '.repeat(60) });
    const k = boundedCacheKey(P, long);
    expect(k).toMatch(/^public:products:[0-9a-f-]+:sha256:[0-9a-f]{64}$/);
    expect(new TextEncoder().encode(`cache:${k}`).length).toBeLessThanOrEqual(512);
    expect(boundedCacheKey(P, long)).toBe(k);
    expect(boundedCacheKey(P, long + ' ')).not.toBe(k);
    expect(CACHE_KEY_MAX_BYTES).toBeLessThan(512 - 'cache:'.length);
  });
  it('measures bytes, not characters (Arabic is 2 bytes a letter)', () => {
    const arabic = 'ك'.repeat(Math.ceil(CACHE_KEY_MAX_BYTES / 2));
    expect(boundedCacheKey(P, arabic)).toContain(':sha256:');
  });
});
