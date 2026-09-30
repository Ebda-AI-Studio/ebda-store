import { describe, it, expect } from 'vitest';
import { makeRateLimitStore } from '../security';

const options = { windowMs: 60_000 } as never;

describe('makeRateLimitStore', () => {
  it('counts in Redis when a redis client is provided', async () => {
    // rate-limit-redis loads its Lua script via `SCRIPT LOAD` and expects a
    // string SHA back. Return a plausible SHA for SCRIPT commands.
    const calls: string[][] = [];
    const fakeRedis = {
      call: (...args: string[]) => {
        calls.push(args);
        return Promise.resolve(
          String(args[0]).toUpperCase() === 'SCRIPT' ? 'deadbeefsha' : [1, 60_000]
        );
      },
    };
    const store = makeRateLimitStore(fakeRedis, 'auth');
    store.init?.(options);
    await store.increment('k');
    expect(calls.some(c => c[0] === 'EVALSHA' && c[3] === 'rl:auth:k')).toBe(true);
  });

  it('counts in process memory when redis is absent', async () => {
    for (const absent of [undefined, null]) {
      const store = makeRateLimitStore(absent, 'auth');
      store.init?.(options);
      expect((await store.increment('k')).totalHits).toBe(1);
      expect((await store.increment('k')).totalHits).toBe(2);
    }
  });
});
