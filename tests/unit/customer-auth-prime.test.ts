// Sentry EBDA-API-Z (N+1 in the */15 cron): resolving the customer-auth marker for N stores must cost O(1) D1 reads, not N.
// `primeCustomerAuthRoutes` fills the same caches `customerAuthOnDo` uses, from ONE batched read per chunk of stores.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  keys: new Map<string, string>(),
  reads: { n: 0 },
  maxParams: { n: 0 },
}));
vi.mock('../../apps/api/src/cf/bindings', () => ({
  cfBindings: () => ({
    PLATFORM_DB: {
      prepare: () => ({
        bind: (...v: string[]) => ({
          all: async () => {
            h.reads.n++;
            h.maxParams.n = Math.max(h.maxParams.n, v.length);
            return {
              results: v.filter(k => h.keys.has(k)).map(k => ({ key: k, value: h.keys.get(k) })),
            };
          },
        }),
      }),
    },
  }),
}));
vi.mock('../../apps/api/src/services/alerts.service', () => ({ sendAlert: async () => undefined }));
vi.mock('../../apps/api/src/lib/store-backend', () => ({
  backendFor: async () => 'do',
  storeDo: () => {
    throw new Error('not reached');
  },
}));

import {
  ANY_FREEZE_KEY,
  customerAuthOnDo,
  freezeKey,
  markerKey,
  primeCustomerAuthRoutes,
  resetCustomerAuthCaches,
} from '../../apps/api/src/lib/customer-auth';

const ids = Array.from({ length: 20 }, (_, i) => `store-${i}`);
beforeEach(() => {
  h.keys.clear();
  h.reads.n = 0;
  h.maxParams.n = 0;
  resetCustomerAuthCaches();
});

describe('primeCustomerAuthRoutes', () => {
  it('baseline: unprimed, N stores cost N marker reads (the N+1)', async () => {
    for (const id of ids) await customerAuthOnDo(id);
    expect(h.reads.n).toBe(20);
  });

  it('primed, 20 stores cost a constant number of reads, then 0 more', async () => {
    h.keys.set(markerKey('store-3'), '{}');
    await primeCustomerAuthRoutes(ids);
    const afterPrime = h.reads.n;
    expect(afterPrime).toBeLessThanOrEqual(2);
    expect(h.maxParams.n).toBeLessThanOrEqual(90); // D1 bind-parameter ceiling is 100
    const got = await Promise.all(ids.map(id => customerAuthOnDo(id)));
    expect(h.reads.n).toBe(afterPrime);
    expect(got.filter(Boolean)).toHaveLength(1);
    expect(got[3]).toBe(true);
  });

  it('keeps the freeze rule: a frozen store is never cached off, so it re-reads', async () => {
    h.keys.set(freezeKey('store-1'), '{}');
    await primeCustomerAuthRoutes(ids);
    const afterPrime = h.reads.n;
    await customerAuthOnDo('store-0'); // cached off
    expect(h.reads.n).toBe(afterPrime);
    await customerAuthOnDo('store-1'); // frozen: not cached
    expect(h.reads.n).toBe(afterPrime + 1);
  });

  it('the any-freeze row freezes every store in the batch', async () => {
    h.keys.set(ANY_FREEZE_KEY, '{}');
    await primeCustomerAuthRoutes(ids);
    const afterPrime = h.reads.n;
    await customerAuthOnDo('store-0');
    expect(h.reads.n).toBe(afterPrime + 1);
  });

  it('does not re-read stores already cached, and does nothing for an empty list', async () => {
    h.keys.set(markerKey('store-0'), '{}');
    await primeCustomerAuthRoutes(['store-0']);
    h.reads.n = 0;
    await primeCustomerAuthRoutes(['store-0']);
    expect(h.reads.n).toBe(0);
    await primeCustomerAuthRoutes([]);
    expect(h.reads.n).toBe(0);
  });
});

describe('primeCustomerAuthRoutes chunking and no-binding', () => {
  it('300 stores: many reads, each under the 100-parameter ceiling (readCutoverKeysMany chunks)', async () => {
    const many = Array.from({ length: 300 }, (_, i) => `big-${i}`);
    h.keys.set(markerKey('big-299'), '{}');
    await primeCustomerAuthRoutes(many);
    expect(h.reads.n).toBeGreaterThan(1);
    expect(h.maxParams.n).toBeLessThanOrEqual(90);
    expect(await customerAuthOnDo('big-299')).toBe(true); // marker found in a later chunk
    expect(await customerAuthOnDo('big-0')).toBe(false);
  });
});
