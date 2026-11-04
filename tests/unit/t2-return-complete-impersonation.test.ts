/** Ruling FP-3: completing a return sends money back, so an impersonated session gets 403 IMPERSONATION_FORBIDDEN. */
import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

let impersonatedBy: string | undefined;
vi.mock('@ebda/database', async importOriginal => ({
  ...(await importOriginal<object>()),
  prisma: {
    user: { findFirst: vi.fn(), findUnique: vi.fn(), update: vi.fn() },
    store: { findFirst: vi.fn() },
  },
}));
vi.mock('@api/services/redis.service', () => ({
  redis: { get: vi.fn(), set: vi.fn(), delete: vi.fn(), getClient: vi.fn(() => null) },
}));
vi.mock('@api/middleware/auth', async importOriginal => ({
  ...(await importOriginal<object>()),
  authenticate: (req: any, _res: any, next: any) => {
    req.user = { userId: 'u1', role: 'store_admin', impersonatedBy };
    next();
  },
}));
vi.mock('@api/middleware/rbac', async importOriginal => ({
  ...(await importOriginal<object>()),
  requirePermission: () => (_q: any, _s: any, n: any) => n(),
}));
vi.mock('@api/middleware/store-access', async importOriginal => ({
  ...(await importOriginal<object>()),
  requireStoreAccess: (_q: any, _s: any, n: any) => n(),
}));
vi.mock('@api/middleware/feature-gate', () => ({
  requireFeature: () => (_q: any, _s: any, n: any) => n(),
}));
const complete = vi.fn();
vi.mock('@api/services/return.service', async importOriginal => ({
  ...(await importOriginal<object>()),
  ReturnService: { complete: (...a: unknown[]) => complete(...a) },
}));

describe('POST /returns/admin/:id/complete under impersonation', () => {
  it('403 for an impersonated token, before the service is touched', async () => {
    impersonatedBy = 'platform-admin';
    const { default: router } = await import('@api/routes/return.routes');
    const app = express();
    app.use(express.json());
    app.use('/stores/:storeId/returns', router);
    const res = await request(app)
      .post('/stores/s1/returns/admin/r1/complete')
      .send({ refundMethod: 'manual' });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('IMPERSONATION_FORBIDDEN');
    expect(complete).not.toHaveBeenCalled();
  });
});
