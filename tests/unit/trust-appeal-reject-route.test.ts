/**
 * Super-admin rejection of a suspension appeal (POST /stores/:id/suspension/appeal/reject): sets status=rejected and
 * rejected_at, writes an audit row, 404 with no open appeal, 403 for a merchant. The merchant cooldown keys on
 * rejected_at (see self-service-trust-and-support.test.ts).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

const h = vi.hoisted(() => ({
  rows: [] as Record<string, any>[],
  audit: vi.fn(),
}));
const db = {
  findFirst: async ({ where }: any) =>
    h.rows.find(
      r => r.storeId === where.storeId && r.kind === where.kind && r.status === where.status
    ) ?? null,
  updateMany: async ({ where, data }: any) => {
    const hit = h.rows.filter(r => r.id === where.id && r.status === where.status);
    hit.forEach(r => Object.assign(r, data));
    return { count: hit.length };
  },
  create: vi.fn(),
  count: vi.fn(),
};
vi.mock('@api/lib/definer', () => ({ insertAuditLog: h.audit }));
vi.mock('@api/middleware/auth', () => ({
  rejectImpersonated: (_q: any, _s: any, n: any) => n(),
  authenticate: (req: any, _res: any, next: any) => {
    req.user = { userId: 'admin-1', role: req.header('x-role') ?? 'super_admin' };
    next();
  },
  authorize:
    (...roles: string[]) =>
    (req: any, res: any, next: any) =>
      roles.includes(req.user.role) ? next() : res.status(403).json({ success: false }),
  customerUserId: () => 'customer-1',
}));
vi.mock('@api/middleware/require-mfa', () => ({
  requireMfaEnrolled: (_req: any, _res: any, next: any) => next(),
}));
vi.mock('@api/middleware/store-access', () => ({
  requireStoreAccess: (_req: any, _res: any, next: any) => next(),
  checkStoreAccess: (_req: any, _res: any, next: any) => next(),
}));
vi.mock('@api/middleware/feature-gate', () => ({
  requireFeature: () => (_req: any, _res: any, next: any) => next(),
}));
vi.mock('@api/middleware/rbac', () => ({
  requirePermission: () => (_req: any, _res: any, next: any) => next(),
}));
vi.mock('@api/middleware/security', () => ({
  auditLog: vi.fn().mockResolvedValue(undefined),
  writeLimiter: (_req: any, _res: any, next: any) => next(),
}));
vi.mock('@api/utils/store-helpers', () => ({ getAuthUser: (req: any) => req.user }));
vi.mock('@api/lib/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('@ebda/database', () => ({
  prisma: { store: { findUnique: vi.fn(), findFirst: vi.fn(), update: vi.fn() }, trustRequest: db },
  Prisma: { DbNull: null },
  StoreStatus: { active: 'active', suspended: 'suspended' },
  runInTenantContext: (_s: string, fn: () => unknown) => fn(),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  withStore: async (_s: string, fn: any) => fn((await import('@ebda/database')).prisma),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  withUser: async (_u: string, fn: any) => fn((await import('@ebda/database')).prisma),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  asPlatformOperator: (_u: string, fn: any) => fn(),
}));
vi.mock('@api/middleware/tenant-context', () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tenantContext: (_req: any, _res: any, next: any) => next(),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  storeScopeContext: (_req: any, _res: any, next: any) => next(),
}));

// The per-account daily cap (SP5 task 4) is covered in self-serve-abuse.test.ts;
// here it is a pass-through so the route's slug contract stays the subject.
vi.mock('@api/services/store-creation-limit', () => ({
  assertStoreCreationBudget: vi.fn().mockResolvedValue(undefined),
  withStoreCreationLock: (_owner: string, fn: () => unknown) => fn(),
}));
vi.mock('@api/services/plan-limit.service', () => ({ assertWithinLimit: vi.fn() }));

const svc = vi.hoisted(() => ({
  create: vi.fn(),
  update: vi.fn(),
  getById: vi.fn(),
  updateBrandingBundle: vi.fn(),
  setStatus: vi.fn(),
  updateTemplate: vi.fn(),
}));
vi.mock('@api/services/store.service', () => ({
  StoreService: svc,
  applySocialLinksPatch: vi.fn(),
}));
vi.mock('@api/services/domain-provider', () => ({
  resolveDomainService: vi.fn(() => ({ isConfigured: () => false })),
}));
vi.mock('@api/services/store-mailer.service', () => ({ StoreMailer: {} }));
vi.mock('@api/services/feature.service', () => ({
  featureService: { invalidateCache: vi.fn().mockResolvedValue(undefined) },
}));
vi.mock('@api/lib/cors-cache', () => ({ bustCorsCache: vi.fn() }));
vi.mock('@api/lib/public-cache', () => ({
  invalidateCached: vi.fn(),
  invalidateCachedPrefix: vi.fn(),
  invalidateStoreProductCaches: vi.fn(),
  invalidateCustomersCache: vi.fn(),
}));
vi.mock('@api/lib/marketing-pixels-secrets', () => ({
  maskMarketingPixelSecrets: (v: unknown) => v,
  preserveMaskedPixelSecrets: (v: unknown) => v,
}));
vi.mock('@api/config', () => ({ config: { cfFallbackOrigin: 'fallback.example.com' } }));

const STORE_ID = '11111111-1111-1111-1111-111111111111';
let app: express.Express;
beforeEach(async () => {
  h.rows.length = 0;
  h.audit.mockReset().mockResolvedValue(undefined);
  if (!app) {
    const { default: router } = await import('@api/routes/store.routes');
    const { errorHandler } = await import('@api/middleware/error-handler');
    app = express();
    app.use(express.json());
    app.use('/stores', router);
    app.use(errorHandler);
  }
});

describe('POST /stores/:id/suspension/appeal/reject', () => {
  const url = `/stores/${STORE_ID}/suspension/appeal/reject`;
  it('rejects the open appeal, stamps rejected_at and writes an audit row', async () => {
    h.rows.push({ id: 'a1', storeId: STORE_ID, kind: 'suspension_appeal', status: 'open' });
    const res = await request(app).post(url);
    expect(res.status).toBe(200);
    expect(h.rows[0].status).toBe('rejected');
    expect(h.rows[0].rejectedAt).toBeInstanceOf(Date);
    expect(h.audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'store.suspension_appeal_reject',
        storeId: STORE_ID,
        resourceId: 'a1',
        userId: 'admin-1',
      })
    );
  });
  it('is 404 when there is no open appeal, and rejects only once', async () => {
    expect((await request(app).post(url)).status).toBe(404);
    h.rows.push({ id: 'a1', storeId: STORE_ID, kind: 'suspension_appeal', status: 'open' });
    expect((await request(app).post(url)).status).toBe(200);
    expect((await request(app).post(url)).status).toBe(404);
    expect(h.audit).toHaveBeenCalledTimes(1);
  });
  it('a merchant (store_admin) cannot reject: 403, nothing changes', async () => {
    h.rows.push({ id: 'a1', storeId: STORE_ID, kind: 'suspension_appeal', status: 'open' });
    const res = await request(app).post(url).set('x-role', 'store_admin');
    expect(res.status).toBe(403);
    expect(h.rows[0].status).toBe('open');
  });
});
