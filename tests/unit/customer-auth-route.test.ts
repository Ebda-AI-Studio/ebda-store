// N-9 routing: a DO store's customers are served by its StoreDO exactly when its marker (or the global one) exists; a Postgres
// write is refused while the store is frozen; an unreadable marker fails closed; scoped one-time tokens address the right DO.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  keys: new Map<string, string>(),
  fail: { v: false },
  backend: new Map<string, 'do' | 'pg'>(),
  reads: { n: 0 },
  alerts: [] as string[],
}));
vi.mock('../../apps/api/src/cf/bindings', () => ({
  cfBindings: () => ({
    PLATFORM_DB: {
      prepare: () => ({
        bind: (...v: string[]) => ({
          all: async () => {
            h.reads.n++;
            if (h.fail.v) throw new Error('d1 down');
            return {
              results: v.filter(k => h.keys.has(k)).map(k => ({ key: k, value: h.keys.get(k) })),
            };
          },
        }),
      }),
    },
  }),
}));
vi.mock('../../apps/api/src/services/alerts.service', () => ({
  sendAlert: async (a: { title: string }) => {
    h.alerts.push(a.title);
  },
}));
vi.mock('../../apps/api/src/lib/store-backend', () => ({
  backendFor: async (id: string) => h.backend.get(id) ?? 'pg',
  storeDo: () => {
    throw new Error('not reached');
  },
}));

import {
  assertNoCustomerAuthFreeze,
  clientForScopedToken,
  customerAuthRoute,
  markerKey,
  freezeKey,
  GLOBAL_MARKER_KEY,
  ANY_FREEZE_KEY,
  mintScopedToken,
  resetCustomerAuthCaches,
  scopedTokenStore,
  sha256,
} from '../../apps/api/src/lib/customer-auth';

const S = '11111111-1111-4111-8111-111111111111';
beforeEach(() => {
  h.keys.clear();
  h.fail.v = false;
  h.backend.clear();
  h.reads.n = 0;
  h.alerts.length = 0;
  resetCustomerAuthCaches();
});

describe('customerAuthRoute', () => {
  it('no store (admin namespace) and Postgres stores are pg, with no D1 read', async () => {
    expect(await customerAuthRoute(null, { write: true })).toEqual({ kind: 'pg' });
    expect(await customerAuthRoute(S, { write: true })).toEqual({ kind: 'pg' });
    expect(h.reads.n).toBe(0);
  });
  it('a DO store without a marker is pg; with its marker or the global one it is do; "on" is cached', async () => {
    h.backend.set(S, 'do');
    expect(await customerAuthRoute(S, { write: false })).toEqual({ kind: 'pg' });
    h.keys.set(markerKey(S), '{}');
    resetCustomerAuthCaches();
    expect((await customerAuthRoute(S, { write: false })).kind).toBe('do');
    const reads = h.reads.n;
    await customerAuthRoute(S, { write: false });
    expect(h.reads.n).toBe(reads); // cached
    h.keys.clear();
    resetCustomerAuthCaches();
    h.keys.set(GLOBAL_MARKER_KEY, '{}');
    expect((await customerAuthRoute(S, { write: false })).kind).toBe('do');
  });
  it('"off" is re-read after the TTL, not every call', async () => {
    h.backend.set(S, 'do');
    await customerAuthRoute(S, { write: false });
    await customerAuthRoute(S, { write: false });
    expect(h.reads.n).toBe(1);
  });
  it('an unreadable marker is a 503 (fail closed), never a silent pg', async () => {
    h.backend.set(S, 'do');
    h.fail.v = true;
    await expect(customerAuthRoute(S, { write: true })).rejects.toMatchObject({ statusCode: 503 });
  });
});

describe('freeze (#407 semantics)', () => {
  const live = () => JSON.stringify({ expiresAt: Date.now() + 60_000 });
  it('a write for a frozen DO store is a retryable 503; a read still answers (pg before the flip)', async () => {
    h.backend.set(S, 'do');
    h.keys.set(freezeKey(S), live());
    await expect(customerAuthRoute(S, { write: true })).rejects.toMatchObject({
      statusCode: 503,
      code: 'CUSTOMER_AUTH_FROZEN',
    });
    expect(await customerAuthRoute(S, { write: false })).toEqual({ kind: 'pg' });
  });
  it('"off" is never cached while frozen, so the very read after the flip sees the marker', async () => {
    h.backend.set(S, 'do');
    h.keys.set(freezeKey(S), live());
    await customerAuthRoute(S, { write: false });
    await customerAuthRoute(S, { write: false });
    expect(h.reads.n).toBe(2);
    h.keys.set(markerKey(S), '{}');
    expect((await customerAuthRoute(S, { write: false })).kind).toBe('do');
  });
  it('marker + freeze coexisting: a write is refused until the freeze lifts (no mixed backends)', async () => {
    h.backend.set(S, 'do');
    h.keys.set(markerKey(S), '{}');
    h.keys.set(freezeKey(S), live());
    await expect(customerAuthRoute(S, { write: true })).rejects.toMatchObject({ statusCode: 503 });
    h.keys.delete(freezeKey(S));
    expect((await customerAuthRoute(S, { write: true })).kind).toBe('do');
  });
  it('an expired freeze is ignored and pages once (P1)', async () => {
    h.backend.set(S, 'do');
    h.keys.set(freezeKey(S), JSON.stringify({ expiresAt: Date.now() - 1 }));
    expect(await customerAuthRoute(S, { write: true })).toEqual({ kind: 'pg' });
    await customerAuthRoute(S, { write: true });
    expect(h.alerts).toHaveLength(1);
  });
  it('the any-freeze guards unscoped Postgres-era tokens', async () => {
    await expect(assertNoCustomerAuthFreeze()).resolves.toBeUndefined();
    h.keys.set(ANY_FREEZE_KEY, live());
    await expect(assertNoCustomerAuthFreeze()).rejects.toMatchObject({
      code: 'CUSTOMER_AUTH_FROZEN',
    });
  });
  it('a write never trusts a cached "off"', async () => {
    h.backend.set(S, 'do');
    await customerAuthRoute(S, { write: false }); // caches off
    h.keys.set(markerKey(S), '{}');
    expect((await customerAuthRoute(S, { write: true })).kind).toBe('do');
  });
});

describe('scoped one-time tokens', () => {
  it('mint -> parse -> hash is stable; junk and oversize never parse', () => {
    const { token, hash } = mintScopedToken(S);
    expect(scopedTokenStore(token)).toBe(S);
    expect(sha256(token)).toBe(hash);
    for (const bad of [
      '',
      'x',
      'a'.repeat(64),
      `${S}~short`,
      `~${'a'.repeat(64)}`,
      `${S}~${'g'.repeat(64)}`,
      5,
      null,
      {},
      `${S}~${'a'.repeat(64)}x`,
    ])
      expect(scopedTokenStore(bad)).toBeNull();
    expect(scopedTokenStore('a'.repeat(300))).toBeNull();
  });
  it('an unscoped token, or a scoped one for a store not on its DO, is not ours (pg path)', async () => {
    expect(await clientForScopedToken('a'.repeat(64))).toBeNull();
    expect(await clientForScopedToken(mintScopedToken(S).token)).toBeNull();
    h.backend.set(S, 'do');
    h.keys.set(markerKey(S), '{}');
    const c = await clientForScopedToken(mintScopedToken(S).token);
    expect(c?.storeId).toBe(S);
  });
});

describe('markCustomerAuthOnDo (store-create)', () => {
  it('writes the per-store marker idempotently, and the router then serves the store from its DO', async () => {
    const { markCustomerAuthOnDo } = await import('../../apps/api/src/lib/customer-auth');
    const writes: unknown[][] = [];
    const db = {
      prepare: (sql: string) => ({
        bind: (...v: unknown[]) => ({
          run: async () => {
            expect(sql).toMatch(/ON CONFLICT \(key\) DO NOTHING/);
            writes.push(v);
            h.keys.set(v[1] as string, v[2] as string);
          },
        }),
      }),
    };
    await markCustomerAuthOnDo(db, S);
    expect(writes[0][1]).toBe(markerKey(S));
    h.backend.set(S, 'do');
    expect((await customerAuthRoute(S, { write: true })).kind).toBe('do');
  });
});
