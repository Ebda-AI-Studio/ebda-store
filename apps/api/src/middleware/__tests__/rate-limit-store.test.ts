import { describe, it, expect } from 'vitest';
import { makeRateLimitStore } from '../security';

describe('makeRateLimitStore', () => {
  it('returns a redis store when a redis client is provided', () => {
    // rate-limit-redis loads its Lua script via `SCRIPT LOAD` at init and
    // expects a string SHA back. A minimal fake that returns a non-string for
    // that command makes rate-limit-redis throw "unexpected reply from redis
    // client" in an unawaited init promise → an unhandled rejection that fails
    // the whole vitest run. Return a plausible SHA for SCRIPT commands.
    const fakeRedis = {
      call: (...args: string[]) =>
        Promise.resolve(String(args[0]).toUpperCase() === 'SCRIPT' ? 'deadbeefsha' : 1),
    } as never;
    const store = makeRateLimitStore(fakeRedis, 'auth');
    expect(store).toBeDefined();
    expect(store?.constructor.name).toMatch(/RedisStore/);
  });

  it('returns undefined (in-memory default) when redis is absent', () => {
    expect(makeRateLimitStore(undefined, 'auth')).toBeUndefined();
    expect(makeRateLimitStore(null, 'auth')).toBeUndefined();
  });
});
