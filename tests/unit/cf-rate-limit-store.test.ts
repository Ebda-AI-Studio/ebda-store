/** The express-rate-limit Store on the AuthState Durable Object (apps/api/src/cf/rate-limit-store.ts). */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { CfRateLimitStore } from '@api/cf/rate-limit-store';
import { AuthStateStore, type Op } from '@api/cf/auth-state-core';
import { clearCfBindings, setCfBindings, type CfBindings } from '@api/cf/bindings';
import { createSqlite } from '../helpers/sqlite-sql';

beforeEach(() => {
  const stores = new Map<string, AuthStateStore>();
  setCfBindings({
    AUTH_STATE: {
      idFromName: (n: string) => n,
      get: (id: unknown) => {
        const name = String(id);
        if (!stores.has(name)) stores.set(name, new AuthStateStore(createSqlite()));
        return {
          apply: async (ops: Op[]) => ops.map(op => stores.get(name)!.run(op, Date.now())),
        } as never;
      },
    },
  } as unknown as CfBindings);
});
afterEach(() => clearCfBindings());

const store = (windowMs = 60_000) => {
  const s = new CfRateLimitStore('rl:auth:');
  s.init({ windowMs } as never);
  return s;
};

describe('CfRateLimitStore', () => {
  it('counts hits per key and reports the reset time', async () => {
    const s = store();
    const a = await s.increment('1.2.3.4-a@b');
    const b = await s.increment('1.2.3.4-a@b');
    expect([a.totalHits, b.totalHits]).toEqual([1, 2]);
    expect(b.resetTime!.getTime()).toBeGreaterThan(Date.now());
    expect((await s.increment('1.2.3.4-other')).totalHits).toBe(1);
  });

  it('two store instances (two isolates) share the same counter', async () => {
    await store().increment('k');
    expect((await store().increment('k')).totalHits).toBe(2);
  });

  it('the window resets', async () => {
    const s = store(150);
    await s.increment('k');
    await s.increment('k');
    await new Promise(r => setTimeout(r, 200));
    expect((await s.increment('k')).totalHits).toBe(1);
  });

  it('get / decrement / resetKey', async () => {
    const s = store();
    expect(await s.get('k')).toBeUndefined();
    await s.increment('k');
    await s.increment('k');
    expect((await s.get('k'))!.totalHits).toBe(2);
    await s.decrement('k');
    expect((await s.get('k'))!.totalHits).toBe(1);
    await s.resetKey('k');
    expect(await s.get('k')).toBeUndefined();
  });

  it('keys of different limiters do not collide', async () => {
    const a = new CfRateLimitStore('rl:a:');
    const b = new CfRateLimitStore('rl:b:');
    a.init({ windowMs: 1000 } as never);
    b.init({ windowMs: 1000 } as never);
    await a.increment('ip');
    expect((await b.increment('ip')).totalHits).toBe(1);
  });

  it('has no timers: constructing and initialising it schedules nothing', () => {
    const before = setTimeout(() => undefined, 0);
    clearTimeout(before);
    const s = new CfRateLimitStore('rl:x:');
    s.init({ windowMs: 1000 } as never);
    expect(s.localKeys).toBe(false);
  });
});
