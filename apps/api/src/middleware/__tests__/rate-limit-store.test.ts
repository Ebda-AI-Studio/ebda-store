import { describe, it, expect } from 'vitest';
import { makeRateLimitStore } from '../security';

describe('makeRateLimitStore', () => {
  it('returns a redis store when a redis client is provided', () => {
    const fakeRedis = { call: () => Promise.resolve(1) } as never;
    const store = makeRateLimitStore(fakeRedis, 'auth');
    expect(store).toBeDefined();
    expect(store?.constructor.name).toMatch(/RedisStore/);
  });

  it('returns undefined (in-memory default) when redis is absent', () => {
    expect(makeRateLimitStore(undefined, 'auth')).toBeUndefined();
    expect(makeRateLimitStore(null, 'auth')).toBeUndefined();
  });
});
