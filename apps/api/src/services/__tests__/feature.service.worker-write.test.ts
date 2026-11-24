import { describe, it, expect, vi, beforeEach } from 'vitest';

// A feature toggle must not open a Postgres interactive transaction: on the Worker Postgres is removed (POSTGRES_REMOVED), so
// `withMoneyTx(prisma, ...)` answered 500 on PUT /stores/:id/ci/hints and every other feature switch.
const m = vi.hoisted(() => ({
  bust: vi.fn(),
  redisDelete: vi.fn(),
  upsert: vi.fn(async () => ({})),
  findMany: vi.fn(async () => [{ featureKey: 'customer_intelligence', enabled: true }]),
  storeFind: vi.fn(async () => ({ plan: 'free', slug: 's', domain: null })),
  withMoneyTx: vi.fn(async () => {
    throw new Error('POSTGRES_REMOVED: Postgres was removed from the Worker');
  }),
}));
vi.mock('../store.service', () => ({ bustStoreCaches: m.bust }));
vi.mock('../redis.service', () => ({
  redis: {
    get: vi.fn(async () => null),
    set: vi.fn(),
    delete: m.redisDelete,
    deleteByPattern: vi.fn(),
  },
}));
vi.mock('../../lib/repo-factory', () => ({
  storeRepo: vi.fn(async () => ({ backend: 'pg' })),
  storeUpdate: vi.fn(),
}));
vi.mock('../plan-entitlements', () => ({ getAutomationFlags: vi.fn(async () => null) }));
vi.mock('@ebda/database', () => ({
  prisma: new Proxy(
    {},
    {
      get: () => {
        throw new Error('POSTGRES_REMOVED: prisma touched');
      },
    }
  ),
  Prisma: {},
  withMoneyTx: m.withMoneyTx,
  withStore: vi.fn(async (_id: string, fn: (tx: unknown) => unknown) =>
    fn({
      store: { findUnique: m.storeFind },
      storeFeature: { upsert: m.upsert, findMany: m.findMany },
      billingEvent: { findMany: async () => [] }, // running add-ons (none here)
    })
  ),
}));

import { featureService } from '../feature.service';

describe('FeatureService.updateStoreFeatures on the Worker', () => {
  beforeEach(() => vi.clearAllMocks());
  it('writes through the store scope and never opens a Postgres transaction', async () => {
    const out = await featureService.setFeature('st1', 'customer_intelligence', true, 'u1');
    expect(m.withMoneyTx).not.toHaveBeenCalled();
    expect(m.upsert).toHaveBeenCalledTimes(1);
    expect(out.customer_intelligence).toBe(true);
  });
});

describe('FeatureService.updateStoreFeatures: a failed multi-key write', () => {
  it('drops the cached feature map and rethrows (D1 has no multi-key transaction)', async () => {
    vi.clearAllMocks();
    m.upsert.mockResolvedValueOnce({}).mockRejectedValueOnce(new Error('d1 down'));
    await expect(
      featureService.updateStoreFeatures(
        'st1',
        { customer_intelligence: true, bundles: true } as never,
        'u1'
      )
    ).rejects.toThrow('d1 down');
    expect(m.redisDelete).toHaveBeenCalledWith(expect.stringContaining('st1'));
    expect(m.bust).toHaveBeenCalledWith('st1', 's', null);
  });
});
