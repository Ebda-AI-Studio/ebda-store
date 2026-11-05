/**
 * Issue 2172 — `PUT /admin/stores/:id` (super_admin) writes `plan` directly
 * and busted the public store caches, but never FeatureService's own
 * `features:store:<id>` cache (300s). The public payload embeds
 * `enabledFeatures` computed from that cache, so the bust made the very next
 * public request RE-SEED `public:store:*` from the stale feature map.
 *
 * Pins the order: feature cache dropped first, then the public caches.
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
// SP5: a plan change also re-points the store's subscription (own DB write, not under test here).
vi.mock('@api/services/plan-sync', () => ({
  syncSubscriptionFromLegacyPlan: vi.fn(async () => {
    calls.push('syncSubscription');
  }),
}));
vi.mock('@ebda/database', async importOriginal => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    asPlatformOperator: (_userId: string, fn: () => unknown) => fn(),
    withStore: async (_storeId: string, fn: (tx: unknown) => unknown) => fn({}),
    prisma: {
      store: {
        findUnique: vi.fn().mockResolvedValue({ slug: 'demo' }),
        update: (...a: unknown[]) => mockUpdate(...a),
      },
    },
  };
});

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

describe('PUT /admin/stores/:id — plan change cache order (issue 2172)', () => {
  beforeEach(() => {
    calls.length = 0;
    vi.clearAllMocks();
    mockUpdate.mockResolvedValue({
      id: 'store-1',
      slug: 'demo',
      domain: 'demo.example',
      plan: 'professional',
      owner: null,
    });
  });

  it('drops the feature cache BEFORE busting the public store caches', async () => {
    const res = await request(app()).put('/admin/stores/store-1').send({ plan: 'professional' });
    expect(res.status).toBe(200);
    expect(calls).toEqual([
      'syncSubscription',
      'featureService.invalidateCache',
      'bustStoreCaches',
    ]);
  });

  it('a non-plan edit does not touch the feature cache', async () => {
    const res = await request(app()).put('/admin/stores/store-1').send({ name: 'Renamed' });
    expect(res.status).toBe(200);
    expect(calls).toEqual(['bustStoreCaches']);
  });
});
