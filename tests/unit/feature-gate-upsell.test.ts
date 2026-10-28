/**
 * 403 FEATURE_DISABLED carries the SOLD plan that unlocks the feature, but only when the
 * PLAN is what withholds it (a merchant/super-admin toggle never becomes an upsell).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Request, Response, NextFunction } from 'express';

const isFeatureEnabled = vi.fn();
vi.mock('../../apps/api/src/services/feature.service', () => ({
  featureService: { isFeatureEnabled: (...a: unknown[]) => isFeatureEnabled(...a) },
}));
const getEntitlements = vi.fn();
vi.mock('../../apps/api/src/services/plan-entitlements', () => ({
  getEntitlements: (...a: unknown[]) => getEntitlements(...a),
}));
vi.mock('../../apps/api/src/utils/store-helpers', () => ({
  resolvePublicStoreId: async () => null,
}));
vi.mock('../../apps/api/src/lib/logger', () => ({
  default: { warn: vi.fn(), debug: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

import { requireFeature } from '../../apps/api/src/middleware/feature-gate';

function run(feature: 'loyalty' | 'coupons') {
  const req = {
    params: { storeId: 's1' },
    headers: {},
    user: { role: 'store_admin' },
  } as unknown as Request;
  const res = {
    statusCode: 0,
    body: undefined as any,
    status(c: number) {
      this.statusCode = c;
      return this;
    },
    json(p: unknown) {
      this.body = p;
      return this;
    },
  };
  return requireFeature(feature)(
    req,
    res as unknown as Response,
    vi.fn() as unknown as NextFunction
  ).then(() => res);
}

beforeEach(() => {
  vi.clearAllMocks();
  isFeatureEnabled.mockResolvedValue(false);
});

describe('requireFeature 403 upgrade target', () => {
  it('names Growth (not Professional) for a Basic store missing loyalty', async () => {
    getEntitlements.mockResolvedValue({ planCode: 'basic', limits: {} });
    const res = await run('loyalty');
    expect(res.statusCode).toBe(403);
    expect(res.body.code).toBe('FEATURE_DISABLED');
    expect(res.body.upgradeTo).toMatchObject({ code: 'growth', nameEn: 'Growth' });
    expect(JSON.stringify(res.body)).not.toMatch(/Professional|Enterprise|Starter/);
  });
  it('adds no upgrade target when the plan already includes the feature (a toggle)', async () => {
    getEntitlements.mockResolvedValue({ planCode: 'growth', limits: {} });
    const res = await run('loyalty');
    expect(res.statusCode).toBe(403);
    expect(res.body.upgradeTo).toBeUndefined();
  });
  it('fails closed (plain 403) when entitlements cannot be read', async () => {
    getEntitlements.mockRejectedValue(new Error('db down'));
    const res = await run('loyalty');
    expect(res.statusCode).toBe(403);
    expect(res.body.upgradeTo).toBeUndefined();
  });
});
