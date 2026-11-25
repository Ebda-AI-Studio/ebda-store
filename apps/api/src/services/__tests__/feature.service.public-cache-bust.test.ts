import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * audit-followup #1668: `enabledFeatures` is embedded in the
 * `/public/stores/:slugOrId` and `/public/store/resolve` payloads, which are
 * cached under `public:store:*` (120s TTL) INDEPENDENTLY of FeatureService's
 * own `features:store:*` cache. `updateStoreFeatures`/`setFeature`,
 * `clearFeatureOverride`, `resetAllOverrides` and `setStorePlan` only ever
 * touched the latter — a super-admin toggle meant to be a fast rollback
 * lever (llms.txt, the storefront) could sit stale for up to that OTHER
 * cache's TTL. This proves every write path now busts `bustStoreCaches`
 * (the same helper `store.service.ts` uses) with the store's resolved
 * slug/domain.
 */

const { mockBustStoreCaches } = vi.hoisted(() => ({
  mockBustStoreCaches: vi.fn(),
}));

vi.mock('../store.service', () => ({
  bustStoreCaches: mockBustStoreCaches,
}));

const { mockRedisGet, mockRedisSet, mockRedisDelete } = vi.hoisted(() => ({
  mockRedisGet: vi.fn(),
  mockRedisSet: vi.fn(),
  mockRedisDelete: vi.fn(),
}));

vi.mock('../redis.service', () => ({
  redis: {
    get: mockRedisGet,
    set: mockRedisSet,
    delete: mockRedisDelete,
    deleteByPattern: vi.fn(),
  },
}));

const {
  mockStoreFindUnique,
  mockStoreFeatureFindMany,
  mockStoreFeatureUpsert,
  mockStoreFeatureDelete,
  mockStoreFeatureDeleteMany,
  mockStoreUpdate,
  mockWithMoneyTx,
} = vi.hoisted(() => ({
  mockStoreFindUnique: vi.fn(),
  mockStoreFeatureFindMany: vi.fn(),
  mockStoreFeatureUpsert: vi.fn(),
  mockStoreFeatureDelete: vi.fn(),
  mockStoreFeatureDeleteMany: vi.fn(),
  mockStoreUpdate: vi.fn(),
  mockWithMoneyTx: vi.fn(),
}));

vi.mock('@ebda/database', () => ({
  prisma: {
    storeFeature: {
      delete: mockStoreFeatureDelete,
      deleteMany: mockStoreFeatureDeleteMany,
      findMany: mockStoreFeatureFindMany,
    },
    store: { update: mockStoreUpdate, findUnique: mockStoreFindUnique },
  },
  Prisma: {},
  withMoneyTx: mockWithMoneyTx,
  // `bustPublicStoreCache` reads the store's slug/domain via withStore,
  // same shape as the existing single-flight test's mock.
  withStore: vi.fn(async (_storeId: string, fn: (tx: unknown) => unknown) =>
    fn({
      store: { findUnique: mockStoreFindUnique, update: mockStoreUpdate },
      // clearFeatureOverride / resetAllOverrides delete through withStore since #116 (bound store).
      storeFeature: {
        findMany: mockStoreFeatureFindMany,
        upsert: mockStoreFeatureUpsert,
        delete: mockStoreFeatureDelete,
        deleteMany: mockStoreFeatureDeleteMany,
      },
      billingEvent: { findMany: async () => [] }, // running add-ons (none here)
      // plans engine (SP5): no subscription row -> the plan resolves from the legacy enum
      storeSubscription: { findUnique: vi.fn().mockResolvedValue(null), upsert: vi.fn() },
      plan: { findUnique: vi.fn().mockResolvedValue(null) },
    })
  ),
}));

import { featureService } from '../feature.service';

const STORE_ID = 'store-1';

describe('FeatureService — public cache bust (audit-followup #1668)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRedisGet.mockResolvedValue(null);
    mockRedisSet.mockResolvedValue(undefined);
    mockRedisDelete.mockResolvedValue(undefined);
    mockStoreFindUnique.mockResolvedValue({ slug: 'test-store', domain: null });
    mockStoreFeatureFindMany.mockResolvedValue([]);
    mockWithMoneyTx.mockImplementation(async (_client: unknown, fn: (tx: unknown) => unknown) =>
      fn({
        storeFeature: { upsert: mockStoreFeatureUpsert, findMany: mockStoreFeatureFindMany },
        store: { findUnique: mockStoreFindUnique },
        billingEvent: { findMany: async () => [] }, // running add-ons (none here)
        // plans engine (SP5): no subscription row -> the plan resolves from the legacy enum
        storeSubscription: { findUnique: vi.fn().mockResolvedValue(null), upsert: vi.fn() },
        plan: { findUnique: vi.fn().mockResolvedValue(null) },
      })
    );
  });

  it('updateStoreFeatures busts the public store cache with the resolved slug/domain', async () => {
    await featureService.updateStoreFeatures(STORE_ID, { bundles: true }, 'user-1');
    expect(mockBustStoreCaches).toHaveBeenCalledWith(STORE_ID, 'test-store', null);
  });

  it('setFeature (delegates to updateStoreFeatures) busts the public store cache', async () => {
    await featureService.setFeature(STORE_ID, 'bundles', true, 'user-1');
    expect(mockBustStoreCaches).toHaveBeenCalledWith(STORE_ID, 'test-store', null);
  });

  it('clearFeatureOverride busts the public store cache', async () => {
    mockStoreFeatureDelete.mockResolvedValue({});
    await featureService.clearFeatureOverride(STORE_ID, 'bundles');
    expect(mockBustStoreCaches).toHaveBeenCalledWith(STORE_ID, 'test-store', null);
  });

  it('resetAllOverrides busts the public store cache', async () => {
    mockStoreFeatureDeleteMany.mockResolvedValue({ count: 3 });
    await featureService.resetAllOverrides(STORE_ID);
    expect(mockBustStoreCaches).toHaveBeenCalledWith(STORE_ID, 'test-store', null);
  });

  it('setStorePlan busts the public store cache', async () => {
    mockStoreUpdate.mockResolvedValue({});
    await featureService.setStorePlan(STORE_ID, 'professional', 'user-1');
    expect(mockBustStoreCaches).toHaveBeenCalledWith(STORE_ID, 'test-store', null);
  });

  it('does not throw when the store cannot be found (safe no-op)', async () => {
    mockStoreFindUnique.mockResolvedValue(null);
    mockStoreFeatureDelete.mockResolvedValue({});
    await expect(featureService.clearFeatureOverride(STORE_ID, 'bundles')).resolves.toBeDefined();
    expect(mockBustStoreCaches).not.toHaveBeenCalled();
  });

  it('does not throw when bustStoreCaches itself fails (best-effort)', async () => {
    mockBustStoreCaches.mockRejectedValueOnce(new Error('redis down'));
    mockStoreFeatureDelete.mockResolvedValue({});
    await expect(featureService.clearFeatureOverride(STORE_ID, 'bundles')).resolves.toBeDefined();
  });
});
