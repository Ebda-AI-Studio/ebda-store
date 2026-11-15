/**
 * Add-on entitlement is NEVER-stale (Ruling ADDON-SS-3): the cached feature map dies at the soonest paid term end, a
 * pending/failed payment never turns a feature on, and the catalogue, the gate hint and the admin all name the same
 * sellable features.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { redisSet, running } = vi.hoisted(() => ({
  redisSet: vi.fn(),
  running: {
    value: [] as Array<{ eventId: string; sku: string; endsAt: Date; cancelAtPeriodEnd: boolean }>,
  },
}));

vi.mock('@api/services/redis.service', () => ({
  redis: { get: vi.fn().mockResolvedValue(null), set: redisSet, delete: vi.fn() },
}));
vi.mock('@api/services/billing/addon-grant', () => ({ activeAddons: async () => running.value }));
vi.mock('@ebda/database', () => ({
  prisma: {},
  Prisma: {},
  withMoneyTx: vi.fn(),
  withStore: vi.fn(async (_id: string, fn: (tx: unknown) => unknown) =>
    fn({
      store: { findUnique: vi.fn().mockResolvedValue({ plan: 'free' }) },
      storeFeature: { findMany: vi.fn().mockResolvedValue([]) },
      storeSubscription: { findUnique: vi.fn().mockResolvedValue(null) },
      plan: { findUnique: vi.fn().mockResolvedValue(null) },
    })
  ),
}));

import { featureService, ttlFor } from '@api/services/feature.service';
import { ADDON_CATALOG } from '@api/services/billing/addon-catalog';
import { FEATURE_KEYS_ARRAY, addonSkuForFeature } from '@ebda/shared';

describe('entitlement cache TTL', () => {
  beforeEach(() => {
    redisSet.mockClear();
    running.value = [];
  });

  it('ttlFor: default 300 s, cut at the term end, never below 1 s', () => {
    const now = 1_000_000;
    expect(ttlFor(null, now)).toBe(300);
    expect(ttlFor(new Date(now + 3_600_000), now)).toBe(300);
    expect(ttlFor(new Date(now + 42_000), now)).toBe(42);
    expect(ttlFor(new Date(now - 5_000), now)).toBe(1);
  });

  it('a running term ending in 20 s: the Redis entry is written with a TTL <= 20 s', async () => {
    running.value = [
      {
        eventId: 'e1',
        sku: 'feature:floating_widget',
        endsAt: new Date(Date.now() + 20_000),
        cancelAtPeriodEnd: false,
      },
    ];
    const map = await featureService.getStoreFeatures('store-ttl-1');
    expect(map.floating_widget).toBe(true);
    const ttl = redisSet.mock.calls[0][2] as number;
    expect(ttl).toBeGreaterThanOrEqual(1);
    expect(ttl).toBeLessThanOrEqual(20);
  });

  it('no running term: default TTL, feature off (a pending or failed payment grants nothing)', async () => {
    const map = await featureService.getStoreFeatures('store-ttl-2');
    expect(map.floating_widget).toBe(false);
    expect(redisSet.mock.calls[0][2]).toBe(300);
  });

  it('the soonest of several terms wins', async () => {
    running.value = [
      {
        eventId: 'a',
        sku: 'feature:loyalty',
        endsAt: new Date(Date.now() + 200_000),
        cancelAtPeriodEnd: false,
      },
      {
        eventId: 'b',
        sku: 'feature:affiliate',
        endsAt: new Date(Date.now() + 30_000),
        cancelAtPeriodEnd: true,
      },
    ];
    await featureService.getStoreFeatures('store-ttl-3');
    expect(redisSet.mock.calls[0][2] as number).toBeLessThanOrEqual(30);
  });

  it('an AI pack term does not shorten the feature cache', async () => {
    running.value = [
      {
        eventId: 'p',
        sku: 'ai:topup_300',
        endsAt: new Date(Date.now() + 5_000),
        cancelAtPeriodEnd: false,
      },
    ];
    await featureService.getStoreFeatures('store-ttl-4');
    expect(redisSet.mock.calls[0][2]).toBe(300);
  });
});

describe('catalogue, gate hint and admin agree on the sellable features', () => {
  it('addonSkuForFeature is non-null for exactly the features the catalogue sells, and names the real sku', () => {
    const sold = new Map(
      Object.values(ADDON_CATALOG)
        .filter(i => i.kind === 'feature')
        .map(i => [i.featureKey as string, i.sku])
    );
    for (const k of FEATURE_KEYS_ARRAY) expect(addonSkuForFeature(k)).toBe(sold.get(k) ?? null);
    expect(addonSkuForFeature(null)).toBeNull();
    expect(addonSkuForFeature('not_a_feature')).toBeNull();
  });

  it('every catalogue item has an en and ar name and description', () => {
    for (const i of Object.values(ADDON_CATALOG)) {
      for (const f of [i.nameEn, i.nameAr]) expect(f.trim().length).toBeGreaterThan(3);
      for (const f of [i.descEn, i.descAr]) expect(f.trim().length).toBeGreaterThan(30);
    }
  });
});
