/**
 * Issue 2172 — a plan change busted the public store caches but not FeatureService's own `features:store:<id>` cache
 * (300s). The public payload embeds `enabledFeatures` computed from that cache, so the bust made the very next public
 * request RE-SEED `public:store:*` from the stale feature map. Pins the order: feature cache dropped first, then the
 * public caches.
 *
 * Ruling B1-PLAN-SOT-1 (#891): the plan is no longer written by `PUT /admin/stores/:id` (refused, 400
 * PLAN_VIA_SUBSCRIPTION); the super admin changes it through `PUT /admin/stores/:id/subscription` (planService.assignPlan),
 * so the ordering guarantee is pinned on THAT path.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

const { calls, mockUpdate } = vi.hoisted(() => ({
  calls: [] as string[],
  mockUpdate: vi.fn(),
}));

vi.mock('@api/middleware/auth', () => ({
  authenticate: (req: any, _res: any, next: any) => {
    req.user = { userId: 'admin-1', role: 'super_admin' };
    next();
  },
  authorize: () => (_req: any, _res: any, next: any) => next(),
}));
vi.mock('@api/middleware/require-mfa', () => ({
  requireMfaEnrolled: (_req: any, _res: any, next: any) => next(),
}));
vi.mock('@api/middleware/security', () => ({ auditLog: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@api/services/store.service', () => ({
  bustStoreCaches: vi.fn(async () => {
    calls.push('bustStoreCaches');
  }),
}));
vi.mock('@api/services/feature.service', () => ({
  featureService: {
    invalidateCache: vi.fn(async () => {
      calls.push('featureService.invalidateCache');
    }),
  },
}));
vi.mock('@api/lib/public-cache', () => ({ invalidateCached: vi.fn() }));
vi.mock('@api/middleware/rbac', () => ({
  requireRole: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock('@ebda/database', async importOriginal => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    asPlatformOperator: (_userId: string, fn: () => unknown) => fn(),
    withStore: async (_storeId: string, fn: (tx: unknown) => unknown) =>
      fn({
        storeSubscription: {
          upsert: vi.fn(async () => {
            calls.push('subscription.upsert');
          }),
        },
      }),
    prisma: {
      plan: { findUnique: vi.fn(async () => ({ code: 'growth', featureTier: 'professional' })) },
      store: {
        findUnique: vi.fn().mockResolvedValue({ slug: 'demo' }),
        update: (...a: unknown[]) => mockUpdate(...a),
      },
    },
  };
});
// assignPlan's store reads/writes and its after-steps (not under test here)
vi.mock('@api/lib/repo-factory', async importOriginal => ({
  ...(await importOriginal<Record<string, unknown>>()),
  storeDb: async () => ({
    store: { findUnique: async () => ({ id: STORE, slug: 'demo', domain: null }) },
  }),
  // assignPlan's derived tier write is recorded; the PUT /admin/stores/:id write goes to the store update mock
  storeUpdate: vi.fn(async (_client: unknown, args: { data?: Record<string, unknown> }) => {
    if (args?.data && 'plan' in args.data) {
      calls.push('stores.plan');
      return {};
    }
    return mockUpdate(args);
  }),
}));
vi.mock('@api/services/billing/account.service', async importOriginal => ({
  ...(await importOriginal<Record<string, unknown>>()),
  reconcileStoreAccess: vi.fn(async () => undefined),
}));
vi.mock('@api/services/staff-invite.service', async importOriginal => ({
  ...(await importOriginal<Record<string, unknown>>()),
  expireInvitesBeyondSeats: vi.fn(async () => undefined),
}));
const STORE = '11111111-1111-4111-8111-111111111111';

// The router wraps every request in the acting user's tenant transaction (`userContext`); this
// file is about the handlers, so the wrapper is a pass-through (it has its own DB-backed coverage).
vi.mock('@api/middleware/tenant-context', () => ({
  userContext: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  platformUserContext: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));

import adminRoutes from '@api/routes/admin.routes';
import { errorHandler } from '@api/middleware/error-handler';

function app() {
  const a = express();
  a.use(express.json());
  a.use('/admin', adminRoutes);
  a.use(errorHandler);
  return a;
}

describe('plan change cache order (issue 2172), on the path that changes plans (B1-PLAN-SOT-1)', () => {
  beforeEach(() => {
    calls.length = 0;
    vi.clearAllMocks();
    mockUpdate.mockResolvedValue({
      id: STORE,
      slug: 'demo',
      domain: 'demo.example',
      plan: 'professional',
      owner: null,
    });
  });

  it('PUT /admin/stores/:id/subscription drops the feature cache BEFORE busting the public store caches', async () => {
    const res = await request(app())
      .put(`/admin/stores/${STORE}/subscription`)
      .send({ planCode: 'growth' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(calls).toEqual([
      'subscription.upsert',
      'stores.plan',
      'featureService.invalidateCache',
      'bustStoreCaches',
    ]);
  });

  it('PUT /admin/stores/:id with a plan is refused with a clear error and writes nothing', async () => {
    const res = await request(app()).put(`/admin/stores/${STORE}`).send({ plan: 'professional' });
    expect(res.status).toBe(400);
    expect(res.body.error?.code).toBe('PLAN_VIA_SUBSCRIPTION');
    expect(mockUpdate).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
  });

  it('a non-plan edit does not touch the feature cache', async () => {
    const res = await request(app()).put(`/admin/stores/${STORE}`).send({ name: 'Renamed' });
    expect(res.status).toBe(200);
    expect(calls).toEqual(['bustStoreCaches']);
  });
});
