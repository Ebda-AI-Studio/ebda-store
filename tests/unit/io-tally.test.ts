/**
 * PERF-LATENCY: the per-request I/O tally (lib/io-tally.ts), its Server-Timing entries, the credential-path rule, and the
 * request-scoped memo (lib/request-memo.ts). The end-to-end call-count budgets live in apps/api/workers-test/latency-budget.test.ts.
 */
import { describe, it, expect } from 'vitest';
import {
  formatIoTiming,
  instrumentBindings,
  newIoTally,
  runWithIoTally,
} from '../../apps/api/src/lib/io-tally';
import { showsIoCounts } from '../../apps/api/src/lib/request-timing';
import {
  requestMemo,
  runWithRequestMemo,
  seedRequestMemo,
} from '../../apps/api/src/lib/request-memo';

const tick = (ms = 1) => new Promise(r => setTimeout(r, ms));

function fakeEnv() {
  const calls: string[] = [];
  const stmt = (sql: string, raw: unknown[] = []): Record<string, unknown> => ({
    sql,
    raw,
    bind: (...v: unknown[]) => stmt(sql, v),
    first: async () => (calls.push(`first:${sql}`), { ok: 1 }),
    all: async () => (calls.push(`all:${sql}`), { results: [] }),
    run: async () => (calls.push(`run:${sql}`), {}),
  });
  const d1 = {
    prepare: (sql: string) => stmt(sql),
    batch: async (stmts: Array<{ sql: string }>) => {
      // a real D1 refuses anything that is not its own statement object: the wrapper must unwrap
      for (const s of stmts)
        if (!('sql' in s) || typeof s.sql !== 'string') throw new Error('foreign');
      calls.push(`batch:${stmts.length}`);
      return [];
    },
  };
  const stub = { query: async () => (calls.push('do:query'), 'r'), then: undefined };
  const ns = { idFromName: (n: string) => n, get: () => stub };
  const kv = { get: async () => (calls.push('kv:get'), null) };
  const accounts = { isRevoked: async () => (calls.push('accounts:isRevoked'), false) };
  return {
    env: {
      PLATFORM_DB: d1,
      STORE_DO: ns,
      AUTH_STATE: ns,
      KV_CACHE: kv,
      ACCOUNTS: accounts,
      OTHER: 1,
    },
    calls,
  };
}

describe('io tally', () => {
  it('counts every binding kind and the serial waves; parallel calls are one wave', async () => {
    const { env } = fakeEnv();
    const b = instrumentBindings(env) as any;
    const t = newIoTally();
    await runWithIoTally(t, async () => {
      await b.PLATFORM_DB.prepare('SELECT 1').bind(1).first(); // wave 1
      await Promise.all([
        b.STORE_DO.get(b.STORE_DO.idFromName('s')).query(), // wave 2
        b.AUTH_STATE.get('x').query(),
        b.ACCOUNTS.isRevoked('sid'),
      ]);
      await b.KV_CACHE.get('k'); // wave 3
      await b.PLATFORM_DB.batch([b.PLATFORM_DB.prepare('A'), b.PLATFORM_DB.prepare('B')]); // wave 4, one call
    });
    expect(t.n).toEqual({
      d1: 2,
      'store-do': 1,
      'auth-state': 1,
      'do-other': 0,
      accounts: 1,
      kv: 1,
    });
    expect(t.waves).toBe(4);
    const st = formatIoTiming(t).join(', ');
    expect(st).toMatch(/^d1;desc="2";dur=\d+\.\d, store-do;desc="1"/);
    expect(st).toContain('io-waves;desc="4"');
    expect(st).not.toContain('do-other');
  });

  it('outside a request nothing is tallied and the wrapper returns the original value', async () => {
    const { env, calls } = fakeEnv();
    const b = instrumentBindings(env) as any;
    expect(await b.STORE_DO.get('s').query()).toBe('r');
    expect(calls).toEqual(['do:query']);
    expect(b.OTHER).toBe(1);
  });

  it('wraps once per env object and passes `then` through (a stub is never mistaken for a promise)', () => {
    const { env } = fakeEnv();
    expect(instrumentBindings(env)).toBe(instrumentBindings(env));
    const b = instrumentBindings(env) as any;
    expect(b.STORE_DO.get('s').then).toBeUndefined();
  });
});

describe('Server-Timing io counts on credential paths', () => {
  it('production hides them on sign-in / register / reset / staff invites, shows them elsewhere', () => {
    for (const p of [
      '/api/v1/auth/login',
      '/api/v1/auth/register',
      '/auth/forgot-password',
      '/api/v1/staff-invites/x',
    ])
      expect(showsIoCounts(p, 'production')).toBe(false);
    for (const p of ['/api/v1/public/orders', '/api/v1/stores/x/cart', '/api/v1/authors'])
      expect(showsIoCounts(p, 'production')).toBe(true);
    expect(showsIoCounts('/api/v1/auth/login', 'development')).toBe(true);
  });
});

describe('request memo', () => {
  it('one load per key per request; concurrent callers share it; a failed load is not kept', async () => {
    let loads = 0;
    let fail = true;
    const load = async () => {
      loads++;
      await tick();
      if (fail) throw new Error('503');
      return 'do';
    };
    await runWithRequestMemo(async () => {
      await expect(requestMemo('k', load)).rejects.toThrow('503');
      fail = false;
      const [a, b] = await Promise.all([requestMemo('k', load), requestMemo('k', load)]);
      expect([a, b]).toEqual(['do', 'do']);
      expect(await requestMemo('k', load)).toBe('do');
    });
    expect(loads).toBe(2); // the failure, then ONE shared successful load
  });

  it('is never shared between requests, and is a pass-through outside one', async () => {
    let loads = 0;
    const load = async () => ++loads;
    await runWithRequestMemo(async () => {
      seedRequestMemo('seeded', 'pg');
      expect(await requestMemo('seeded', async () => 'never')).toBe('pg');
      await requestMemo('k', load);
    });
    await runWithRequestMemo(() => requestMemo('k', load));
    await requestMemo('k', load);
    await requestMemo('k', load);
    expect(loads).toBe(4);
  });
});
