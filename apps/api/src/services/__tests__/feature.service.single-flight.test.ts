import { describe, it, expect, vi, beforeEach } from 'vitest';

// --- Mocks -----------------------------------------------------------------
// M1 (docs/audits/2026-07-13-cache-stampede.md): before this fix,
// `FeatureService` had no single-flight guard — every concurrent cold-key
// caller ran its own `readFromDb()` (2 DB queries: Store + StoreFeature).
// The hottest uncoalesced call site is `cart.service.ts`'s
// `isFeatureEnabled(storeId, 'inventory.backorder')` on every add-to-cart.
// This test proves two concurrent calls on a cold key now share ONE DB
// fetch, mirroring `public-cache.ts`'s `inFlight` map pattern.

const { mockRedisGet, mockRedisSet } = vi.hoisted(() => ({
  mockRedisGet: vi.fn(),
  mockRedisSet: vi.fn(),
}));

vi.mock('../redis.service', () => ({
  redis: {
    get: mockRedisGet,
    set: mockRedisSet,
    delete: vi.fn(),
    deleteByPattern: vi.fn(),
  },
}));

const { mockStoreFindUnique, mockStoreFeatureFindMany } = vi.hoisted(() => ({
  mockStoreFindUnique: vi.fn(),
  mockStoreFeatureFindMany: vi.fn(),
}));

vi.mock('@ebda/database', () => ({
  prisma: {
    storeFeature: { deleteMany: vi.fn(), delete: vi.fn() },
    store: { update: vi.fn() },
  },
  Prisma: {},
  withMoneyTx: vi.fn(),
  withStore: vi.fn(async (_storeId: string, fn: (tx: unknown) => unknown) =>
    fn({
      store: { findUnique: mockStoreFindUnique },
      storeFeature: { findMany: mockStoreFeatureFindMany },
      billingEvent: { findMany: async () => [] }, // running add-ons (none here)
      // plans engine (SP5): no subscription row -> the plan resolves from the legacy enum
      storeSubscription: { findUnique: vi.fn().mockResolvedValue(null), upsert: vi.fn() },
      plan: { findUnique: vi.fn().mockResolvedValue(null) },
    })
  ),
}));

import { featureService } from '../feature.service';

describe('FeatureService.getStoreFeatures — M1 single-flight regression', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // NODE_ENV === 'test' already makes `readFromCache` a guaranteed miss
    // (see feature.service.ts's own test-environment note), but keep the
    // Redis mock cold too so this test doesn't depend on that detail.
    mockRedisGet.mockResolvedValue(null);
    mockRedisSet.mockResolvedValue(undefined);
  });

  it('two concurrent isFeatureEnabled calls on a cold key share exactly one DB fetch', async () => {
    const storeId = 'store-concurrent-backorder-check';

    // Deferred DB response so both callers are guaranteed to be "in flight"
    // at the same time before either resolves — the scenario a flash-sale
    // add-to-cart burst right at a 300s TTL rollover would produce.
    let resolveStore!: (value: { plan: string }) => void;
    mockStoreFindUnique.mockImplementation(
      () =>
        new Promise(resolve => {
          resolveStore = resolve;
        })
    );
    mockStoreFeatureFindMany.mockResolvedValue([]);

    const call1 = featureService.isFeatureEnabled(storeId, 'inventory.backorder');
    const call2 = featureService.isFeatureEnabled(storeId, 'inventory.backorder');

    // Flush pending microtasks so both callers have reached (and are
    // blocked on) the DB read before we let it resolve.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    // Proof of single-flight: only ONE Store fetch was ever dispatched even
    // though two logical callers are currently awaiting a result.
    expect(mockStoreFindUnique).toHaveBeenCalledTimes(1);

    resolveStore({ plan: 'free' });
    const [enabled1, enabled2] = await Promise.all([call1, call2]);

    expect(mockStoreFindUnique).toHaveBeenCalledTimes(1);
    expect(mockStoreFeatureFindMany).toHaveBeenCalledTimes(1);
    expect(enabled1).toBe(enabled2);
  });

  it('a call AFTER the in-flight fetch resolves triggers a fresh DB fetch (no permanent dedup)', async () => {
    const storeId = 'store-sequential';
    mockStoreFindUnique.mockResolvedValue({ plan: 'free' });
    mockStoreFeatureFindMany.mockResolvedValue([]);

    await featureService.isFeatureEnabled(storeId, 'inventory.backorder');
    expect(mockStoreFindUnique).toHaveBeenCalledTimes(1);

    // Cache is bypassed in test env, so a second, non-concurrent call is a
    // fresh cold read — the in-flight map must not leak across calls.
    await featureService.isFeatureEnabled(storeId, 'inventory.backorder');
    expect(mockStoreFindUnique).toHaveBeenCalledTimes(2);
  });
});
