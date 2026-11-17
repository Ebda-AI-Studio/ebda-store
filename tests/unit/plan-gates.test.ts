/**
 * Locked-pricing entitlement gates (docs/plans/done/2026-10-05-pricing-decisions.md).
 * One block per lever, each proven at the SERVER write/resolve path:
 *   stores 1/1/3          assertOwnerMayCreateStore (StoreService.create, OnboardingService.createStore)
 *   branding removal      FeatureService layer -> `remove_branding` (storefront payload + customer email)
 *   Merchant MCP          FeatureService layer -> `merchant_mcp` + `merchant_mcp_write` (Growth + Business, 2026-10-14; NOT `apiAccess`)
 *   analytics tiers       assertAnalyticsTier / requireAnalyticsTier on the insights routes
 *   hidden plans          re-saving a comped store never demotes it
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DEFAULT_PLAN_SEEDS } from '@ebda/shared';

const m = vi.hoisted(() => ({
  storeFindMany: vi.fn(),
  storeFindUnique: vi.fn(),
  featureRows: vi.fn(),
  sub: vi.fn(),
  subUpsert: vi.fn(),
  planFind: vi.fn(),
}));

vi.mock('@api/services/redis.service', () => ({
  redis: { get: vi.fn().mockResolvedValue(null), set: vi.fn(), delete: vi.fn() },
}));
vi.mock('@ebda/database', () => ({
  prisma: { store: { findMany: m.storeFindMany } },
  Prisma: {},
  withMoneyTx: vi.fn(),
  // `stores` is under RLS: the owner's stores are listed as that owner.
  withUser: async (_id: string, fn: (tx: unknown) => unknown) =>
    fn({ store: { findMany: m.storeFindMany } }),
  withStore: async (_id: string, fn: (tx: unknown) => unknown) =>
    fn({
      store: { findUnique: m.storeFindUnique },
      storeFeature: { findMany: m.featureRows },
      storeSubscription: { findUnique: m.sub, upsert: m.subUpsert },
      plan: { findUnique: m.planFind },
    }),
}));
vi.mock('@api/services/socket.service', () => ({ socketService: {} }));
vi.mock('@api/services/email.service', () => ({ EmailService: {} }));
vi.mock('@api/services/store.service', () => ({ bustStoreCaches: vi.fn() }));
vi.mock('@api/config', () => ({ config: {} }));
vi.mock('@api/lib/logger', () => ({
  default: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import { assertAnalyticsTier, assertOwnerMayCreateStore } from '@api/services/plan-limit.service';
import { requireAnalyticsTier } from '@api/middleware/analytics-tier';
import { featureService } from '@api/services/feature.service';
import { syncSubscriptionFromLegacyPlan } from '@api/services/plan-sync';

const seed = (code: string) => DEFAULT_PLAN_SEEDS.find(p => p.code === code)!;

/** Make `storeId` resolve to plan `code` (status active) through the real entitlement code. */
function onPlans(byStore: Record<string, { code: string; status?: string }>) {
  m.sub.mockImplementation(async ({ where }: { where: { storeId: string } }) => {
    const s = byStore[where.storeId];
    return s ? { planCode: s.code, status: s.status ?? 'active' } : null;
  });
  m.planFind.mockImplementation(async ({ where }: { where: { code: string } }) => {
    const p = DEFAULT_PLAN_SEEDS.find(x => x.code === where.code);
    return p ? { code: p.code, nameEn: p.nameEn, nameAr: p.nameAr, limits: p.limits } : null;
  });
  m.storeFindUnique.mockResolvedValue({ plan: 'starter' });
}

beforeEach(() => {
  for (const f of Object.values(m)) f.mockReset();
  m.featureRows.mockResolvedValue([]);
  (featureService as unknown as { connectionOutageAt: number }).connectionOutageAt = 0;
});

describe('maxStores 1 / 1 / 3 — assertOwnerMayCreateStore', () => {
  const owns = (...ids: string[]) =>
    m.storeFindMany.mockResolvedValue(
      ids.map((id, i) => ({ id, createdAt: new Date(1000 * (i + 1)) }))
    );

  it('the first store is always allowed', async () => {
    owns();
    await expect(assertOwnerMayCreateStore('o1')).resolves.toBeUndefined();
  });

  it.each(['basic', 'growth'])('a %s owner cannot add a second store (402)', async code => {
    owns('s1');
    onPlans({ s1: { code } });
    await expect(assertOwnerMayCreateStore('o1')).rejects.toMatchObject({
      statusCode: 402,
      code: 'PLAN_LIMIT_REACHED',
      details: { limitKey: 'maxStores', limit: 1, used: 1 },
    });
  });

  it('a Business owner may hold 3 stores: the 2nd and 3rd pass, the 4th is refused', async () => {
    onPlans({ s1: { code: 'business' }, s2: { code: 'business' }, s3: { code: 'business' } });
    owns('s1');
    await expect(assertOwnerMayCreateStore('o1')).resolves.toBeUndefined();
    owns('s1', 's2');
    await expect(assertOwnerMayCreateStore('o1')).resolves.toBeUndefined();
    owns('s1', 's2', 's3');
    await expect(assertOwnerMayCreateStore('o1')).rejects.toMatchObject({
      statusCode: 402,
      details: { limitKey: 'maxStores', limit: 3, used: 3 },
    });
  });

  it('a canceled Business store falls back to the 1-store free plan (no lapsed multi-store)', async () => {
    owns('s1');
    onPlans({ s1: { code: 'business', status: 'canceled' } });
    await expect(assertOwnerMayCreateStore('o1')).rejects.toMatchObject({ statusCode: 402 });
  });

  it('an unlimited legacy plan (comped) is not capped', async () => {
    owns('s1', 's2', 's3', 's4');
    onPlans({ s1: { code: 'comped' }, s2: { code: 'comped' } });
    await expect(assertOwnerMayCreateStore('o1')).resolves.toBeUndefined();
  });

  it('the OLDEST store (billing parent) decides, not the best plan (Ruling EBDA-FUNNEL-13)', async () => {
    // A child store's own Business row must not keep granting stores once the
    // parent is on Basic (or lapsed): that was the over-limit loophole.
    owns('s1', 's2');
    onPlans({ s1: { code: 'basic' }, s2: { code: 'business' } });
    await expect(assertOwnerMayCreateStore('o1')).rejects.toMatchObject({ statusCode: 402 });
    owns('s1', 's2');
    onPlans({ s1: { code: 'business' }, s2: { code: 'basic' } });
    await expect(assertOwnerMayCreateStore('o1')).resolves.toBeUndefined();
  });
});

describe('brandingRemoval / apiAccess -> feature map (server-resolved, override wins)', () => {
  const features = (code: string) => {
    onPlans({ [`st-${code}`]: { code } });
    return featureService.getStoreFeatures(`st-${code}`);
  };

  it.each([
    ['basic', false],
    ['growth', true],
    ['business', true],
  ])('%s: remove_branding = %s', async (code, expected) => {
    expect((await features(code)).remove_branding).toBe(expected);
  });

  it.each([
    ['basic', false],
    ['growth', true],
    ['business', true],
  ])('%s: merchant_mcp (Growth + Business, Ahmad 2026-10-14) = %s', async (code, expected) => {
    expect((await features(code)).merchant_mcp).toBe(expected);
  });

  it.each([
    ['basic', false],
    ['growth', true],
    ['business', true],
  ])('%s: merchant_mcp_write (MCP write tools) = %s', async (code, expected) => {
    expect((await features(code)).merchant_mcp_write).toBe(expected);
  });

  it('merchant_mcp is decided by the plan rule, not apiAccess: Growth has the MCP but still no apiAccess', async () => {
    const growth = DEFAULT_PLAN_SEEDS.find(p => p.code === 'growth')!;
    expect(growth.limits.apiAccess).toBe(false);
    expect((await features('growth')).merchant_mcp).toBe(true);
  });

  it('merchant_mcp_write: a canceled Growth store falls back to free => off; override wins both ways', async () => {
    onPlans({ 'st-c': { code: 'growth', status: 'canceled' } });
    expect((await featureService.getStoreFeatures('st-c')).merchant_mcp_write).toBe(false);

    onPlans({ 'st-g': { code: 'growth' } });
    m.featureRows.mockResolvedValue([{ featureKey: 'merchant_mcp_write', enabled: false }]);
    expect((await featureService.getStoreFeatures('st-g')).merchant_mcp_write).toBe(false);

    onPlans({ 'st-b': { code: 'basic' } });
    m.featureRows.mockResolvedValue([{ featureKey: 'merchant_mcp_write', enabled: true }]);
    expect((await featureService.getStoreFeatures('st-b')).merchant_mcp_write).toBe(true);
  });

  it('a super-admin StoreFeature override still wins over the plan, both ways', async () => {
    onPlans({ 'st-o': { code: 'basic' } });
    m.featureRows.mockResolvedValue([
      { featureKey: 'remove_branding', enabled: true },
      { featureKey: 'merchant_mcp', enabled: true },
    ]);
    const f = await featureService.getStoreFeatures('st-o');
    expect([f.remove_branding, f.merchant_mcp]).toEqual([true, true]);

    onPlans({ 'st-p': { code: 'business' } });
    m.featureRows.mockResolvedValue([{ featureKey: 'merchant_mcp', enabled: false }]);
    expect((await featureService.getStoreFeatures('st-p')).merchant_mcp).toBe(false);
  });

  it("hidden legacy plans keep today's behaviour: branding shown, API off", async () => {
    for (const code of ['free', 'pro', 'comped']) {
      const f = await features(code);
      expect([code, f.remove_branding, f.merchant_mcp]).toEqual([code, false, false]);
    }
    const f = await features('founding_free');
    expect([f.remove_branding, f.merchant_mcp]).toEqual([true, true]);
  });
});

describe('analytics tiers basic / standard / advanced', () => {
  it.each([
    ['basic', 'standard', false],
    ['basic', 'advanced', false],
    ['growth', 'standard', true],
    ['growth', 'advanced', false],
    ['business', 'advanced', true],
    ['comped', 'advanced', true],
  ] as const)('%s plan asking for %s -> allowed=%s', async (code, min, allowed) => {
    onPlans({ s: { code } });
    const p = assertAnalyticsTier('s', min);
    if (allowed) await expect(p).resolves.toBeUndefined();
    else
      await expect(p).rejects.toMatchObject({
        statusCode: 402,
        code: 'PLAN_LIMIT_REACHED',
        details: { limitKey: 'analyticsTier', required: min },
      });
  });

  it('the route middleware 402s a Basic store, passes Business, and bypasses for super_admin', async () => {
    onPlans({ 'st-basic': { code: 'basic' }, 'st-biz': { code: 'business' } });
    const run = async (storeId: string, role: string) => {
      const next = vi.fn();
      await requireAnalyticsTier('advanced')(
        { user: { role }, params: { storeId } } as never,
        {} as never,
        next
      );
      return next.mock.calls[0]?.[0];
    };
    expect(await run('st-basic', 'store_admin')).toMatchObject({ statusCode: 402 });
    expect(await run('st-biz', 'store_admin')).toBeUndefined();
    expect(await run('st-basic', 'super_admin')).toBeUndefined();
  });
});

describe('hidden plans survive a re-save (syncSubscriptionFromLegacyPlan)', () => {
  const db = () => ({ storeSubscription: { findUnique: m.sub, upsert: m.subUpsert } }) as never;

  it('a comped store re-asserted as `enterprise` keeps its comped row', async () => {
    m.sub.mockResolvedValue({ planCode: 'comped', status: 'comped' });
    await syncSubscriptionFromLegacyPlan(db(), 's', 'enterprise');
    expect(m.subUpsert).not.toHaveBeenCalled();
  });

  it('a comped store explicitly moved to another tier IS re-planned', async () => {
    m.sub.mockResolvedValue({ planCode: 'comped', status: 'comped' });
    await syncSubscriptionFromLegacyPlan(db(), 's', 'starter');
    expect(m.subUpsert).toHaveBeenCalledWith(
      expect.objectContaining({ update: expect.objectContaining({ planCode: 'basic' }) })
    );
  });

  it('a public-plan store follows the enum (professional -> growth)', async () => {
    m.sub.mockResolvedValue({ planCode: 'basic', status: 'active' });
    await syncSubscriptionFromLegacyPlan(db(), 's', 'professional');
    expect(m.subUpsert).toHaveBeenCalledWith(
      expect.objectContaining({ update: expect.objectContaining({ planCode: 'growth' }) })
    );
  });

  it('seeds: comped/founding_free exist and are hidden', () => {
    expect(seed('comped').isPublic || seed('founding_free').isPublic).toBe(false);
  });
});
