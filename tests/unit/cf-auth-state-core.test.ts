/**
 * The AuthState command engine: the Redis subset the API relies on for token revocation, lockout
 * counters, locks and rate limits, on SQLite. `now` is injected, so TTLs are exact.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { AuthStateStore, type Op } from '@api/cf/auth-state-core';
import { createSqlite } from '../helpers/sqlite-sql';

let store: AuthStateStore;
const run = (op: Op, now = 1_000) => store.run(op, now);

beforeEach(() => {
  store = new AuthStateStore(createSqlite());
});

describe('strings and expiry', () => {
  it('SET / GET round-trips and a missing key is null', () => {
    expect(run(['get', 'k'])).toBeNull();
    expect(run(['set', 'k', 'v', {}])).toBe('OK');
    expect(run(['get', 'k'])).toBe('v');
  });

  it('a key with a TTL is invisible from the instant it expires, and PTTL counts down', () => {
    run(['set', 'jti:deny:x', '1', { ttlMs: 500 }], 1_000);
    expect(run(['get', 'jti:deny:x'], 1_499)).toBe('1');
    expect(run(['pttl', 'jti:deny:x'], 1_100)).toBe(400);
    expect(run(['get', 'jti:deny:x'], 1_500)).toBeNull();
    expect(run(['exists', 'jti:deny:x'], 1_500)).toBe(0);
    expect(run(['pttl', 'jti:deny:x'], 1_500)).toBe(-2);
  });

  it('PTTL is -1 for a key with no expiry (the tv key is permanent)', () => {
    run(['set', 'user:tv:u', '3', {}]);
    expect(run(['pttl', 'user:tv:u'], 9_999_999)).toBe(-1);
  });

  it('NX only sets when absent, XX only when present', () => {
    expect(run(['set', 'lock', 'a', { nx: true }])).toBe('OK');
    expect(run(['set', 'lock', 'b', { nx: true }])).toBeNull();
    expect(run(['get', 'lock'])).toBe('a');
    expect(run(['set', 'other', 'x', { xx: true }])).toBeNull();
    expect(run(['set', 'lock', 'c', { xx: true }])).toBe('OK');
  });

  it('NX succeeds again once the holder expired (a lock is not held forever)', () => {
    run(['set', 'lock', 'a', { nx: true, ttlMs: 100 }], 1_000);
    expect(run(['set', 'lock', 'b', { nx: true }], 1_050)).toBeNull();
    expect(run(['set', 'lock', 'b', { nx: true }], 1_100)).toBe('OK');
  });

  it('KEEPTTL keeps the expiry of the value it overwrites', () => {
    run(['set', 'k', '1', { ttlMs: 1000 }], 1_000);
    run(['set', 'k', '2', { keepTtl: true }], 1_200);
    expect(run(['pttl', 'k'], 1_300)).toBe(700);
    expect(run(['get', 'k'], 2_000)).toBeNull();
  });

  it('EXPIRE re-arms a TTL; on a missing key it is 0', () => {
    expect(run(['expire', 'nope', 1000])).toBe(0);
    run(['set', 'k', '1', {}]);
    expect(run(['expire', 'k', 250], 1_000)).toBe(1);
    expect(run(['get', 'k'], 1_249)).toBe('1');
    expect(run(['get', 'k'], 1_250)).toBeNull();
  });

  it('DEL counts what it removed (strings and lists)', () => {
    run(['set', 'a', '1', {}]);
    run(['lpush', 'l', 'x']);
    expect(run(['del', 'a', 'l', 'missing'])).toBe(2);
    expect(run(['exists', 'a', 'l'])).toBe(0);
  });
});

describe('counters (lockout, MFA attempts)', () => {
  it('INCR starts at 1 and counts; DECR goes down', () => {
    expect([1, 2, 3].map(() => run(['incr', 'lockout:a@b:attempts']))).toEqual([1, 2, 3]);
    expect(run(['decr', 'lockout:a@b:attempts'])).toBe(2);
  });

  it('INCR keeps the TTL set by EXPIRE: the window is not extended by every attempt', () => {
    run(['incr', 'c'], 1_000);
    run(['expire', 'c', 900], 1_000);
    run(['incr', 'c'], 1_500);
    expect(run(['pttl', 'c'], 1_600)).toBe(300);
    expect(run(['incr', 'c'], 1_900)).toBe(1); // window over: a fresh counter
  });

  it('INCR on a non-numeric value is an error, not a silent reset', () => {
    run(['set', 'k', 'abc', {}]);
    expect(() => run(['incr', 'k'])).toThrow(/not an integer/);
  });

  it('HIT is a fixed window: counts within it, resets after, reports when it resets', () => {
    expect(run(['hit', 'rl:a', 1000], 5_000)).toEqual([1, 6_000]);
    expect(run(['hit', 'rl:a', 1000], 5_400)).toEqual([2, 6_000]);
    expect(run(['hit', 'rl:a', 1000], 5_999)).toEqual([3, 6_000]);
    expect(run(['hit', 'rl:a', 1000], 6_000)).toEqual([1, 7_000]);
  });

  it('UNHIT gives a request back (skipSuccessfulRequests), never below zero', () => {
    run(['hit', 'rl:b', 1000]);
    run(['unhit', 'rl:b']);
    run(['unhit', 'rl:b']);
    expect(run(['get', 'rl:b'])).toBe('0');
  });
});

describe('scan', () => {
  it('lists live keys by prefix, never expired ones', () => {
    run(['set', 'cache:a:1', 'x', {}]);
    run(['set', 'cache:a:2', 'x', { ttlMs: 10 }], 1_000);
    run(['set', 'cache:b:1', 'x', {}]);
    expect(run(['scan', 'cache:a:'], 1_000)).toEqual(['cache:a:1', 'cache:a:2']);
    expect(run(['scan', 'cache:a:'], 2_000)).toEqual(['cache:a:1']);
  });

  it('a prefix with LIKE metacharacters is matched literally', () => {
    run(['set', '100%_key', 'x', {}]);
    run(['set', '100abckey', 'x', {}]);
    expect(run(['scan', '100%_'])).toEqual(['100%_key']);
  });
});

describe('lists (the dead-letter queues)', () => {
  it('LPUSH adds at the head, RPOP takes the oldest, LRANGE reads newest first', () => {
    run(['lpush', 'q', 'a']);
    run(['lpush', 'q', 'b']);
    expect(run(['lpush', 'q', 'c'])).toBe(3);
    expect(run(['lrange', 'q', 0, -1])).toEqual(['c', 'b', 'a']);
    expect(run(['rpop', 'q'])).toBe('a');
    expect(run(['llen', 'q'])).toBe(2);
    expect(run(['rpop', 'nothing'])).toBeNull();
  });

  it('LRANGE honours offsets and negative indices', () => {
    ['1', '2', '3', '4', '5'].forEach(v => run(['lpush', 'q', v]));
    expect(run(['lrange', 'q', 1, 2])).toEqual(['4', '3']);
    expect(run(['lrange', 'q', -2, -1])).toEqual(['2', '1']);
    expect(run(['lrange', 'q', 3, 1])).toEqual([]);
  });

  it('LTRIM keeps the newest N (the corrupt-entry cap)', () => {
    ['1', '2', '3', '4'].forEach(v => run(['lpush', 'q', v]));
    run(['ltrim', 'q', 0, 1]);
    expect(run(['lrange', 'q', 0, -1])).toEqual(['4', '3']);
    run(['ltrim', 'q', 5, 9]);
    expect(run(['llen', 'q'])).toBe(0);
  });

  it('lists of different keys do not mix', () => {
    run(['lpush', 'email:failed', 'e']);
    run(['lpush', 'sms:failed', 's']);
    expect(run(['rpop', 'email:failed'])).toBe('e');
    expect(run(['llen', 'sms:failed'])).toBe(1);
  });
});

describe('the two ported Lua scripts', () => {
  it('delIfEquals releases only your own lock', () => {
    run(['set', 'leader:job', 'instance-a', { ttlMs: 1000 }]);
    expect(run(['delIfEquals', 'leader:job', 'instance-b'])).toBe(0);
    expect(run(['get', 'leader:job'])).toBe('instance-a');
    expect(run(['delIfEquals', 'leader:job', 'instance-a'])).toBe(1);
    expect(run(['get', 'leader:job'])).toBeNull();
  });

  it('reserveSlot hands out consecutive slots one interval apart', () => {
    const slot = (now: number) => run(['reserveSlot', 'pacer', 1000, 300_000, -1], now);
    expect(slot(10_000)).toEqual([0, 1]);
    expect(slot(10_000)).toEqual([1000, 1]);
    expect(slot(10_000)).toEqual([2000, 1]);
    expect(slot(20_000)).toEqual([0, 1]); // the queue drained: no wait again
  });

  it("reserveSlot does NOT reserve when the wait is past the caller's budget (issue 2298)", () => {
    run(['reserveSlot', 'pacer', 1000, 300_000, -1], 10_000);
    run(['reserveSlot', 'pacer', 1000, 300_000, -1], 10_000);
    const declined = run(['reserveSlot', 'pacer', 1000, 300_000, 500], 10_000);
    expect(declined).toEqual([2000, 0]);
    // The horizon is untouched: the next unbounded caller still gets the slot the decliner would have.
    expect(run(['reserveSlot', 'pacer', 1000, 300_000, -1], 10_000)).toEqual([2000, 1]);
  });
});

describe('atomicity and errors', () => {
  it('an unknown command throws (never a silent no-op)', () => {
    expect(() => run(['flushall'])).toThrow(/unknown command/);
  });

  it('purge deletes expired rows and says whether expiring rows remain', () => {
    run(['set', 'a', '1', { ttlMs: 100 }], 1_000);
    run(['set', 'b', '1', { ttlMs: 10_000 }], 1_000);
    expect(store.purge(1_200)).toBe(true);
    expect(run(['get', 'b'], 1_200)).toBe('1');
    expect(store.purge(20_000)).toBe(false);
  });
});
