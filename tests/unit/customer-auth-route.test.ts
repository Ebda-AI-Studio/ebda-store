// N-9 routing: a DO store's customers are served by its StoreDO exactly when its marker (or the global one) exists; a Postgres
// write is refused while the store is frozen; an unreadable marker fails closed; scoped one-time tokens address the right DO.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  keys: new Set<string>(),
  fail: { v: false },
  backend: new Map<string, 'do' | 'pg'>(),
  reads: { n: 0 },
}));
vi.mock('../../apps/api/src/cf/bindings', () => ({
  cfBindings: () => ({
    PLATFORM_DB: {
      prepare: (sql: string) => ({
        bind: (...v: string[]) => ({
          first: async () => {
            h.reads.n++;
            if (h.fail.v) throw new Error('d1 down');
            const hit = /key IN/.test(sql) ? v.some(k => h.keys.has(k)) : h.keys.has(v[0]);
            return hit ? { ok: 1 } : null;
          },
        }),
      }),
    },
  }),
}));
vi.mock('../../apps/api/src/lib/store-backend', () => ({
  backendFor: async (id: string) => h.backend.get(id) ?? 'pg',
  storeDo: () => {
    throw new Error('not reached');
  },
}));

import {
  assertCustomerAuthNotFrozen,
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
    h.keys.add(markerKey(S));
    resetCustomerAuthCaches();
    expect((await customerAuthRoute(S, { write: false })).kind).toBe('do');
    const reads = h.reads.n;
    await customerAuthRoute(S, { write: false });
    expect(h.reads.n).toBe(reads); // cached
    h.keys.clear();
    resetCustomerAuthCaches();
    h.keys.add(GLOBAL_MARKER_KEY);
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

describe('freeze', () => {
  it('a Postgres write for a frozen DO store is a retryable 503; reads and unfrozen stores pass', async () => {
    h.backend.set(S, 'do');
    h.keys.add(freezeKey(S));
    await expect(customerAuthRoute(S, { write: true })).rejects.toMatchObject({
      statusCode: 503,
      code: 'CUSTOMER_AUTH_FROZEN',
    });
    expect(await customerAuthRoute(S, { write: false })).toEqual({ kind: 'pg' });
    resetCustomerAuthCaches();
    h.keys.clear();
    expect(await customerAuthRoute(S, { write: true })).toEqual({ kind: 'pg' });
  });
  it('the any-freeze guards unscoped Postgres-era tokens', async () => {
    await expect(assertNoCustomerAuthFreeze()).resolves.toBeUndefined();
    resetCustomerAuthCaches();
    h.keys.add(ANY_FREEZE_KEY);
    await expect(assertNoCustomerAuthFreeze()).rejects.toMatchObject({
      code: 'CUSTOMER_AUTH_FROZEN',
    });
    await expect(assertCustomerAuthNotFrozen(S)).resolves.toBeUndefined();
  });
  it('once the marker is on, the freeze is not consulted (the DO is the source)', async () => {
    h.backend.set(S, 'do');
    h.keys.add(markerKey(S));
    h.keys.add(freezeKey(S));
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
    h.keys.add(markerKey(S));
    const c = await clientForScopedToken(mintScopedToken(S).token);
    expect(c?.storeId).toBe(S);
  });
});
