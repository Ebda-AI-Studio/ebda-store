/**
 * Sentry N+1 class (store_features / store_subscriptions per store): resolving the feature map of N stores inside a sweep
 * scope costs a CONSTANT number of platform reads (1 + constant, not N), and every later per-store call is a memo hit.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@api/services/redis.service', () => ({
  redis: { get: vi.fn().mockResolvedValue(null), set: vi.fn(), delete: vi.fn() },
}));

const calls = vi.hoisted(() => ({
  n: { feature: 0, sub: 0, plan: 0, perStore: 0 },
  gone: new Set<string>(),
  pgRemoved: true,
  liveAbandoned: true,
}));
vi.mock('@api/lib/postgres-present', () => ({
  postgresRemovedOnThisWorker: () => calls.pgRemoved,
}));

vi.mock('@ebda/database', () => ({
  prisma: {},
  Prisma: {},
  withMoneyTx: vi.fn(),
  withStore: vi.fn(async (_id: string, fn: (tx: unknown) => unknown) => {
    calls.n.perStore++;
    return fn({
      store: { findUnique: async () => ({ plan: 'free' }) },
      storeFeature: {
        findMany: async () => [{ featureKey: 'abandoned_cart', enabled: calls.liveAbandoned }],
      },
      storeSubscription: { findUnique: async () => null },
      plan: { findUnique: async () => null },
    });
  }),
}));
vi.mock('@api/lib/platform-db', () => ({
  platformDb: async () => ({
    // D1 `stores.plan` is the authoritative plan of a DO store (NZ-D20): readStorePlan reads it here
    store: { findUnique: async () => ({ plan: 'free' }) },
    storeFeature: {
      findMany: async () => {
        calls.n.feature++;
        return [];
      },
    },
    storeSubscription: {
      findUnique: async () => null,
      findMany: async () => {
        calls.n.sub++;
        return [];
      },
    },
    plan: {
      findMany: async () => {
        calls.n.plan++;
        return [];
      },
    },
  }),
}));
vi.mock('@api/lib/repo-factory', () => ({
  storeRepo: async (id: string) => {
    if (calls.gone.has(id)) throw new Error('STORE_NOT_FOUND');
    return {
      backend: 'do',
      db: { store: { findUnique: async () => ({ plan: 'free' }) } },
    };
  },
  storeUpdate: vi.fn(),
  // readStorePlan reads a DO store's plan once per request through this memo (NZ-D20); no request scope here, so just run it
  requestPlanMemo: (_id: string, fn: () => Promise<unknown>) => fn(),
}));

import { featureService } from '@api/services/feature.service';
import { withSweepScope } from '@api/lib/sweep-scope';

describe('feature maps for N stores in a sweep scope', () => {
  beforeEach(() => {
    calls.n = { feature: 0, sub: 0, plan: 0, perStore: 0 };
    calls.gone.clear();
    calls.pgRemoved = true;
    calls.liveAbandoned = true;
  });

  for (const n of [10, 120]) {
    it(`${n} stores: platform reads do not grow with N`, async () => {
      const ids = Array.from({ length: n }, (_, i) => `s${i}`);
      await withSweepScope(async () => {
        await featureService.prefetchStoreFeatures(ids);
        await featureService.selectEnabled(ids, 'abandoned_cart');
      });
      const chunks = Math.ceil(n / 50);
      expect(calls.n.feature).toBe(chunks);
      expect(calls.n.sub).toBe(chunks);
      expect(calls.n.plan).toBe(chunks);
      expect(calls.n.perStore).toBe(0);
    });
  }

  it('1 gone store of 50: only that store resolves per store, the other 49 stay batched', async () => {
    const ids = Array.from({ length: 50 }, (_, i) => `g${i}`);
    calls.gone.add('g7');
    await withSweepScope(async () => {
      await featureService.prefetchStoreFeatures(ids);
    });
    expect(calls.n.feature).toBe(1);
    expect(calls.n.perStore).toBe(0); // prefetch never falls back by itself; the gone store is simply left out
    let selected: string[] = [];
    await withSweepScope(async () => {
      selected = await featureService.selectEnabled(ids, 'abandoned_cart');
    });
    expect(selected).not.toContain('g7'); // live check of the gone store failed -> not selected, sweep goes on
    expect(selected.length).toBe(0); // free plan baseline has no abandoned_cart override rows here
    expect(calls.n.perStore).toBe(1); // exactly the gone store, once
  });

  it('prefetch is skipped when Postgres is bound (getEntitlements reads it first): per-store path', async () => {
    calls.pgRemoved = false;
    await withSweepScope(async () => {
      await featureService.prefetchStoreFeatures(['p1', 'p2']);
    });
    expect(calls.n.feature + calls.n.sub + calls.n.plan).toBe(0);
  });

  it('a downgrade mid-run: selection used the prefetch, the live check before the paid action sees it', async () => {
    calls.liveAbandoned = true;
    await withSweepScope(async () => {
      // prefetch seeds (D1 override rows are empty, so selection comes from the plan baseline)
      await featureService.prefetchStoreFeatures(['d1']);
      // the live entitlement (override row) is revoked mid-run
      calls.liveAbandoned = false;
      const live = await featureService.isFeatureEnabled('d1', 'abandoned_cart');
      expect(live).toBe(false); // the paid side effect is skipped on this answer
      // and invalidateCache drops the prefetched map for the rest of the run
      await featureService.invalidateCache('d1');
    });
  });
});
