/**
 * `GET /admin/stores/:id/features` as super_admin answered 500 `TenantScopeViolation` on a local
 * stack (Ruling TENANT-GUARD-ADMIN-1). The /admin feature router is CONTEXT-LESS (its mount has no
 * `:id`, so `tenantContext` binds no store), and the handler read `store_features` with a bare
 * `prisma.storeFeature.findMany({ where: { storeId } })`: the code-level guard (R-EBDA-003) refuses
 * a tenant-model query with no ambient store, in every environment. The same defect sat in four more
 * handlers/service methods on the router (clear override, reset all, bulk/single update, plan change's
 * previous-plan read) and in `PUT /admin/stores/:id`.
 *
 * The in-process integration suites run the owner-role client WITHOUT the guard (CLAUDE.md), which is
 * why nothing caught it. This test mocks `@ebda/database` with a fake whose models run the REAL
 * `assertTenantScoped` against an ambient store that only `withStore` / `runInTenantContext` set, so
 * a handler that forgets to bind the target store fails here exactly as it does in production.
 */
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import { AsyncLocalStorage } from 'node:async_hooks';
import express, { type Express } from 'express';
import request from 'supertest';
import { assertTenantScoped, TenantScopeViolation } from '../../packages/database/src/tenant-guard';
import type { AmbientScope } from '../../packages/database/src/tenant-scope';

const STORE = '11111111-1111-4111-8111-111111111111';
const ADMIN = '33333333-3333-4333-8333-333333333333';

const h = vi.hoisted(() => ({
  ambient: null as unknown as import('node:async_hooks').AsyncLocalStorage<AmbientScope>,
  guard: null as unknown as (model: string, op: string, args: unknown) => void,
  rows: [] as Array<{
    featureKey: string;
    enabled: boolean;
    enabledAt: Date | null;
    enabledBy: string | null;
    updatedAt: Date;
  }>,
  calls: [] as string[],
}));

vi.mock('@api/services/billing/addon-grant', () => ({ activeAddons: async () => [] }));
vi.mock('@ebda/database', async () => {
  const { AsyncLocalStorage: ALS } = await import('node:async_hooks');
  const guardMod = await import('../../packages/database/src/tenant-guard');
  h.ambient = new ALS<AmbientScope>();
  h.guard = (model, op, args) => {
    guardMod.assertTenantScoped(model, op, args, h.ambient.getStore() ?? {});
    h.calls.push(`${model}.${op}`); // only a query the guard ADMITTED counts as having run
  };
  const model = (name: string, impl: Record<string, (args: any) => unknown>) =>
    Object.fromEntries(
      Object.entries(impl).map(([op, fn]) => [
        op,
        async (args: unknown) => {
          h.guard(name, op, args);
          return fn(args);
        },
      ])
    );
  const prisma: any = {
    storeFeature: model('StoreFeature', {
      findMany: () => h.rows,
      upsert: () => ({}),
      delete: () => ({}),
      deleteMany: () => ({ count: 0 }),
    }),
    store: model('Store', {
      findUnique: () => ({ plan: 'starter', slug: 's', domain: null }),
      update: () => ({}),
    }),
    user: model('User', { findMany: () => [] }),
    storeSubscription: model('StoreSubscription', {
      findUnique: () => ({ planCode: 'growth' }),
    }),
    $transaction: (fn: (tx: unknown) => unknown) => fn(prisma),
  };
  const withStore = (storeId: string, fn: (tx: unknown) => unknown) =>
    h.ambient.run({ ...(h.ambient.getStore() ?? {}), storeId }, () => fn(prisma));
  return {
    prisma,
    withStore,
    withMoneyTx: (p: any, fn: any) => p.$transaction(fn),
    // Opens ONLY the platform directory (Store / User / StoreStaff), as the real hatch does.
    asPlatformOperator: (userId: string, fn: () => unknown) =>
      h.ambient.run({ userId, hatch: 'platform-operator' }, fn),
  };
});

vi.mock('@api/middleware/auth', () => ({
  authenticate: (req: any, _res: any, next: any) => {
    req.user = { userId: ADMIN, role: 'super_admin' };
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
const assignPlan = vi.hoisted(() =>
  vi.fn(async (_id: string, i: { planCode: string }) => ({
    planCode: i.planCode,
    status: 'active',
  }))
);
vi.mock('@api/services/plan.service', () => ({ planService: { assignPlan } }));
vi.mock('@api/services/plan-entitlements', () => ({ getAutomationFlags: vi.fn(async () => null) }));
vi.mock('@api/lib/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

let app: Express;
beforeAll(async () => {
  const { default: featureRouter } = await import('@api/routes/feature.routes');
  const { errorHandler } = await import('@api/middleware/error-handler');
  const server = express();
  server.use(express.json());
  // Same shape as routes/index.ts: bare '/admin' mount, so NO ambient store reaches the handlers.
  server.use('/admin', featureRouter);
  server.use(errorHandler);
  app = server;
});

beforeEach(() => {
  h.calls.length = 0;
  h.rows = [
    {
      featureKey: 'coupons',
      enabled: true,
      enabledAt: new Date(),
      enabledBy: ADMIN,
      updatedAt: new Date(),
    },
  ];
});

describe('the fake enforces the real guard (so a green run means something)', () => {
  it('a bare tenant read with no ambient store throws TenantScopeViolation', async () => {
    const { prisma } = await import('@ebda/database');
    await expect(
      prisma.storeFeature.findMany({ where: { storeId: STORE } } as any)
    ).rejects.toBeInstanceOf(TenantScopeViolation);
    expect(assertTenantScoped).toBeTypeOf('function');
  });
});

describe('/admin/stores/:id/* feature routes bind the target store after authorization', () => {
  const base = `/admin/stores/${STORE}`;

  it('GET features answers 200 (was 500 TenantScopeViolation)', async () => {
    const res = await request(app).get(`${base}/features`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.data.metadata).toHaveLength(1);
    expect(res.body.data.features).toBeTypeOf('object');
  });
  it('PUT features (bulk) answers 200', async () => {
    const res = await request(app).put(`${base}/features`).send({ coupons: true });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
  });
  it('PUT features/:key answers 200', async () => {
    const res = await request(app).put(`${base}/features/coupons`).send({ enabled: true });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
  });
  it('DELETE features/:key really deletes (the route swallows a failed delete, so 200 alone proves nothing)', async () => {
    const res = await request(app).delete(`${base}/features/coupons`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(h.calls).toContain('StoreFeature.delete');
  });
  it('DELETE features (reset all) answers 200', async () => {
    const res = await request(app).delete(`${base}/features`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(h.calls).toContain('StoreFeature.deleteMany');
  });
  it('PUT plan by plan code answers 200 through assignPlan (previous-plan read is store scoped)', async () => {
    const res = await request(app).put(`${base}/plan`).send({ planCode: 'business' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(assignPlan).toHaveBeenCalledWith(STORE, { planCode: 'business' });
    expect(h.calls).toContain('StoreSubscription.findUnique');
    expect(res.body.data).toMatchObject({ planCode: 'business', status: 'active' });
  });
  it('B1-PLAN-SOT-1: PUT plan with a legacy TIER is refused 400 and changes nothing', async () => {
    assignPlan.mockClear();
    const res = await request(app).put(`${base}/plan`).send({ plan: 'professional' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('PLAN_CODE_REQUIRED');
    expect(assignPlan).not.toHaveBeenCalled();
    expect(h.calls).not.toContain('Store.update');
  });
});
