/**
 * Sentry N+1 class (store_features / store_subscriptions per store): resolving the feature map of N stores inside a sweep
 * scope costs a CONSTANT number of platform reads (1 + constant, not N), and every later per-store call is a memo hit.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@api/services/redis.service', () => ({
  redis: { get: vi.fn().mockResolvedValue(null), set: vi.fn(), delete: vi.fn() },
}));

const calls = vi.hoisted(() => ({ n: { feature: 0, sub: 0, plan: 0, perStore: 0 } }));

vi.mock('@ebda/database', () => ({
  prisma: {},
  Prisma: {},
  withMoneyTx: vi.fn(),
  withStore: vi.fn(async () => {
    calls.n.perStore++;
    throw new Error('per-store path must not run');
  }),
}));
vi.mock('@api/lib/platform-db', () => ({
  platformDb: async () => ({
    storeFeature: {
      findMany: async () => {
        calls.n.feature++;
        return [];
      },
    },
    storeSubscription: {
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
  storeRepo: async () => ({
    backend: 'do',
    db: { store: { findUnique: async () => ({ plan: 'free' }) } },
  }),
  storeUpdate: vi.fn(),
}));

import { featureService } from '@api/services/feature.service';
import { withSweepScope } from '@api/lib/sweep-scope';

describe('feature maps for N stores in a sweep scope', () => {
  beforeEach(() => {
    calls.n = { feature: 0, sub: 0, plan: 0, perStore: 0 };
  });

  for (const n of [10, 120]) {
    it(`${n} stores: platform reads do not grow with N`, async () => {
      const ids = Array.from({ length: n }, (_, i) => `s${i}`);
      await withSweepScope(async () => {
        await featureService.prefetchStoreFeatures(ids);
        for (const id of ids) await featureService.isFeatureEnabled(id, 'abandoned_cart');
      });
      const chunks = Math.ceil(n / 50);
      expect(calls.n.feature).toBe(chunks);
      expect(calls.n.sub).toBe(chunks);
      expect(calls.n.plan).toBe(chunks);
      expect(calls.n.perStore).toBe(0);
    });
  }
});
