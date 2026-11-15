/**
 * #843 (Ruling SF-EXPIRY-1): a StoreFeature override can expire. An override past its `expiresAt` resolves to the plan
 * baseline (read time, no sweep); the super-admin route can set / clear an expiry + reason; a past expiry is refused.
 */
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import express, { type Express } from 'express';
import request from 'supertest';

const STORE = '11111111-1111-4111-8111-111111111111';
const h = vi.hoisted(() => ({
  rows: [] as Array<Record<string, unknown>>,
  upserts: [] as Array<Record<string, any>>,
  wholesale: null as null | { enabled: boolean; expiresAt: Date | null },
  wholesaleFlag: false,
}));

vi.mock('@ebda/database', async () => {
  const prisma: any = {
    storeFeature: {
      findMany: async () => h.rows,
      findFirst: async () => h.wholesale,
      upsert: async (args: Record<string, any>) => {
        h.upserts.push(args);
        return {};
      },
    },
    store: { findUnique: async () => ({ plan: 'free', slug: 's', domain: null }) },
    user: { findMany: async () => [] },
    $transaction: (fn: (tx: unknown) => unknown) => fn(prisma),
  };
  return {
    prisma,
    Prisma: {},
    withStore: (_id: string, fn: (tx: unknown) => unknown) => fn(prisma),
    withMoneyTx: (p: any, fn: any) => p.$transaction(fn),
    asPlatformOperator: (_u: string, fn: () => unknown) => fn(),
  };
});
vi.mock('@api/lib/store-plan', () => ({ readStorePlan: async () => ({ plan: 'free' }) }));
vi.mock('@api/middleware/auth', () => ({
  authenticate: (req: any, _res: any, next: any) => {
    req.user = { userId: 'admin', role: 'super_admin' };
    next();
  },
  authorize: () => (_req: any, _res: any, next: any) => next(),
}));
vi.mock('@api/middleware/require-mfa', () => ({
  requireMfaEnrolled: (_req: any, _res: any, next: any) => next(),
}));
vi.mock('@api/middleware/store-access', () => ({
  requireStoreAccess: (_req: any, _res: any, next: any) => next(),
}));
vi.mock('@api/middleware/security', () => ({ auditLog: vi.fn() }));
vi.mock('@api/services/redis.service', () => ({
  redis: { get: vi.fn(), set: vi.fn(), delete: vi.fn() },
}));
vi.mock('@api/services/store.service', () => ({ bustStoreCaches: vi.fn() }));
vi.mock('@api/lib/public-cache', () => ({ invalidateStoreProductCaches: vi.fn() }));
vi.mock('@api/services/plan-sync', () => ({ syncSubscriptionFromLegacyPlan: vi.fn() }));
vi.mock('@api/services/plan-entitlements', () => ({
  getAutomationFlags: vi.fn(async () => ({ wholesalePricing: h.wholesaleFlag })),
}));
vi.mock('@api/lib/customer-directory', () => ({}));
vi.mock('@api/lib/repo-factory', () => ({ storeDb: vi.fn(), storeUpdate: vi.fn() }));
vi.mock('@api/lib/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const DAY = 86_400_000;
const row = (featureKey: string, enabled: boolean, expiresAt: Date | null) => ({
  featureKey,
  enabled,
  enabledAt: null,
  enabledBy: null,
  expiresAt,
  reason: expiresAt ? 'sold add-on' : null,
  updatedAt: new Date(),
});

let app: Express;
beforeAll(async () => {
  const { default: featureRouter } = await import('@api/routes/feature.routes');
  const { errorHandler } = await import('@api/middleware/error-handler');
  const server = express();
  server.use(express.json());
  server.use('/admin', featureRouter);
  server.use(errorHandler);
  app = server;
});
beforeEach(() => {
  h.rows = [];
  h.upserts.length = 0;
  h.wholesale = null;
  h.wholesaleFlag = false;
});

describe('resolution: an expired override falls back to the plan baseline', () => {
  it('bundles (in no plan baseline) is on with no expiry or a future expiry, off once expired', async () => {
    const { featureService } = await import('@api/services/feature.service');
    h.rows = [row('bundles', true, null)];
    expect((await featureService.getStoreFeatures(STORE)).bundles).toBe(true);
    h.rows = [row('bundles', true, new Date(Date.now() + DAY))];
    expect((await featureService.getStoreFeatures(STORE)).bundles).toBe(true);
    h.rows = [row('bundles', true, new Date(Date.now() - 1000))];
    expect((await featureService.getStoreFeatures(STORE)).bundles).toBe(false);
  });

  it('an expired DISABLE override stops removing a baseline feature', async () => {
    const { featureService } = await import('@api/services/feature.service');
    h.rows = [row('coupons', false, null)];
    const withOverride = (await featureService.getStoreFeatures(STORE)).coupons;
    h.rows = [row('coupons', false, new Date(Date.now() - 1000))];
    const expired = (await featureService.getStoreFeatures(STORE)).coupons;
    expect(withOverride).toBe(false);
    expect(expired).toBe(true);
  });

  it('wholesaleEntitledUncached ignores an expired override too', async () => {
    const { wholesaleEntitledUncached } = await import('@api/services/price-resolver.service');
    h.wholesaleFlag = false;
    h.wholesale = { enabled: true, expiresAt: new Date(Date.now() + DAY) };
    expect(await wholesaleEntitledUncached(STORE)).toBe(true);
    h.wholesale = { enabled: true, expiresAt: new Date(Date.now() - 1000) };
    expect(await wholesaleEntitledUncached(STORE)).toBe(false);
  });
});

describe('super-admin route', () => {
  const base = `/admin/stores/${STORE}/features`;

  it('GET returns expiresAt and reason per override', async () => {
    const at = new Date(Date.now() + DAY);
    h.rows = [row('bundles', true, at)];
    const res = await request(app).get(base);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.data.metadata[0]).toMatchObject({
      featureKey: 'bundles',
      expiresAt: at.toISOString(),
      reason: 'sold add-on',
    });
  });

  it('PUT with a future expiry and a reason stores both', async () => {
    const at = new Date(Date.now() + 30 * DAY).toISOString();
    const res = await request(app)
      .put(`${base}/bundles`)
      .send({ enabled: true, expiresAt: at, reason: ' bundles, paid to 2026-12-16 ' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const u = h.upserts[0];
    expect(u.create.expiresAt).toEqual(new Date(at));
    expect(u.update.expiresAt).toEqual(new Date(at));
    expect(u.update.reason).toBe('bundles, paid to 2026-12-16');
  });

  it('PUT with only `enabled` (a toggle) KEEPS the stored expiry and reason', async () => {
    const res = await request(app).put(`${base}/bundles`).send({ enabled: false });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(h.upserts[0].update).not.toHaveProperty('expiresAt');
    expect(h.upserts[0].update).not.toHaveProperty('reason');
    expect(h.upserts[0].create).toMatchObject({ expiresAt: null, reason: null });
  });

  it('PUT with an explicit null CLEARS the expiry and reason', async () => {
    const res = await request(app)
      .put(`${base}/bundles`)
      .send({ enabled: true, expiresAt: null, reason: null });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(h.upserts[0].update).toMatchObject({ expiresAt: null, reason: null });
  });

  it('PUT with an expiry in the past is refused (400) and writes nothing', async () => {
    const res = await request(app)
      .put(`${base}/bundles`)
      .send({ enabled: true, expiresAt: new Date(Date.now() - DAY).toISOString() });
    expect(res.status).toBe(400);
    expect(h.upserts).toHaveLength(0);
  });

  it('the bulk PUT leaves an existing expiry and reason alone', async () => {
    const res = await request(app).put(base).send({ coupons: true });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(h.upserts[0].update).not.toHaveProperty('expiresAt');
    expect(h.upserts[0].update).not.toHaveProperty('reason');
  });
});
