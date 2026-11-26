/**
 * RESOLVE-SWR-1: stale-while-revalidate for the public store payload, with the NEVER-stale classes cleared by event.
 *
 * Real `getCachedSwr` / `getCached` / `invalidateCached`; Redis is an in-memory map that honours TTLs and generation counters
 * on a controllable clock. Asserted: the read windows (fresh / stale / past the hard max), single-flight refresh, and, the
 * point of the design, that a write followed by its bust is NEVER followed by an old value, even when a refresh that began
 * before the write is still running.
 */
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  now: 1_700_000_000_000,
  store: new Map<string, { v: string; exp: number }>(),
  gens: new Map<string, number>(),
}));

vi.mock('@api/services/redis.service', () => ({
  redis: {
    isAvailable: () => true,
    get: async (k: string) => {
      const e = h.store.get(k);
      if (!e || e.exp <= h.now) return null;
      return e.v;
    },
    set: async (k: string, v: string, ttl: number) =>
      void h.store.set(k, { v, exp: h.now + ttl * 1000 }),
    delete: async (k: string) => void h.store.delete(k),
    deleteByPattern: async () => 0,
    getCacheGenerations: async (names: string[]) =>
      names.map(n => (h.gens.has(n) ? String(h.gens.get(n)) : null)),
    bumpCacheGeneration: async (n: string) => void h.gens.set(n, (h.gens.get(n) ?? 0) + 1),
  },
}));
vi.mock('@api/lib/revalidate-storefront', () => ({ revalidateStorefront: vi.fn() }));
vi.mock('@api/lib/logger', () => ({
  default: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import { getCachedSwr, invalidateCached } from '@api/lib/public-cache';

const SOFT = 120;
const HARD = 600;
const KEY = 'public:store:resolve:shop.ebda.app';
const advance = (s: number) => void (h.now += s * 1000);

type Payload = { status: 'active' | 'suspended'; price: number; v: number };
let db: Payload;
let fetches: number;
const fetchFn = async (): Promise<Payload> => {
  fetches++;
  return { ...db };
};
/** Lets an un-awaited background refresh (in-memory mocks only, no real I/O) run to its end. */
const settleRefresh = async () => {
  for (let i = 0; i < 20; i++) await new Promise(r => setImmediate(r));
};
const read = () => getCachedSwr(KEY, SOFT, HARD, fetchFn);

beforeEach(() => {
  h.now = 1_700_000_000_000;
  h.store.clear();
  h.gens.clear();
  db = { status: 'active', price: 100, v: 1 };
  fetches = 0;
  vi.spyOn(Date, 'now').mockImplementation(() => h.now);
});
afterEach(() => vi.restoreAllMocks());

describe('read windows', () => {
  it('a miss fills synchronously; within the soft age nothing refetches', async () => {
    expect((await read()).v).toBe(1);
    advance(SOFT - 1);
    db = { ...db, v: 2 };
    expect((await read()).v).toBe(1);
    expect(fetches).toBe(1);
  });

  it('past the soft age the STALE copy is served at once and ONE refresh runs; the next read is fresh', async () => {
    await read();
    advance(SOFT + 30);
    db = { ...db, v: 2 };
    const stale = await read();
    expect(stale.v).toBe(1); // no wait on the refetch
    await settleRefresh();
    expect(fetches).toBe(2);
    expect((await read()).v).toBe(2);
    expect(fetches).toBe(2);
  });

  it('many stale readers share a single refresh', async () => {
    await read();
    advance(SOFT + 30);
    await Promise.all([read(), read(), read(), read(), read()]);
    await settleRefresh();
    expect(fetches).toBe(2);
  });

  it('past the hard max the entry is gone: a synchronous fill returns the current value', async () => {
    await read();
    advance(HARD + 1);
    db = { ...db, v: 3 };
    expect((await read()).v).toBe(3);
    expect(fetches).toBe(2);
  });

  it('a failed background refresh keeps serving the stale copy and does not throw', async () => {
    await read();
    advance(SOFT + 30);
    const boom = async (): Promise<Payload> => {
      fetches++;
      throw new Error('D1 down');
    };
    expect((await getCachedSwr(KEY, SOFT, HARD, boom)).v).toBe(1);
    await settleRefresh();
    expect((await getCachedSwr(KEY, SOFT, HARD, boom)).v).toBe(1);
  });

  it('an entry written before the envelope existed (a bare value) is read as an ordinary entry', async () => {
    h.store.set(KEY, {
      v: JSON.stringify({ status: 'active', price: 1, v: 9 }),
      exp: h.now + 60_000,
    });
    expect((await read()).v).toBe(9);
    expect(fetches).toBe(0);
  });
});

describe('NEVER-stale: a bust is never followed by an old value', () => {
  it('suspension: after the write + bust the suspended store is served, at every age, never the cached active one', async () => {
    expect((await read()).status).toBe('active');
    for (const age of [0, SOFT - 1, SOFT + 30, HARD - 1]) {
      h.store.clear();
      h.gens.clear();
      h.now += 0;
      await read(); // cache the ACTIVE payload
      advance(age);
      db = { ...db, status: 'suspended' }; // the write ...
      await invalidateCached(KEY); // ... and its bust
      expect((await read()).status, `age ${age}s`).toBe('suspended');
      db = { ...db, status: 'active' };
    }
  });

  it('price/plan change: same rule (the entry is deleted by the bust, so there is no stale copy left to serve)', async () => {
    await read();
    advance(SOFT + 30); // would be served stale without a bust
    db = { ...db, price: 120, v: 2 };
    await invalidateCached(KEY);
    expect((await read()).price).toBe(120);
  });

  it('a refresh that began BEFORE the write cannot republish the pre-write value', async () => {
    await read();
    advance(SOFT + 30);
    let release!: () => void;
    const gate = new Promise<void>(r => (release = r));
    let phase = 0;
    let started!: () => void;
    const hasStarted = new Promise<void>(r => (started = r));
    const slowFetch = async (): Promise<Payload> => {
      phase++;
      const snapshot = { ...db }; // reads the OLD row
      started();
      await gate; // ... the write and its bust land while this read is in flight
      return snapshot;
    };
    await getCachedSwr(KEY, SOFT, HARD, slowFetch); // serves stale, starts the refresh
    await hasStarted; // the refresh has READ the old row; only now does the write land
    db = { ...db, status: 'suspended', v: 2 }; // the write
    await invalidateCached(KEY); // its bust
    release();
    await settleRefresh();
    expect(phase).toBe(1);
    // the refresh finished with the pre-write snapshot but must not have stored it
    expect((await read()).status).toBe('suspended');
  });

  it('a bust drops the single-flight marker so the next stale read can start a new refresh', async () => {
    await read();
    advance(SOFT + 30);
    let release!: () => void;
    const gate = new Promise<void>(r => (release = r));
    await getCachedSwr(KEY, SOFT, HARD, async () => {
      await gate;
      return { ...db };
    });
    await invalidateCached(KEY);
    release();
    await settleRefresh();
    db = { ...db, v: 5 };
    expect((await read()).v).toBe(5);
  });
});
