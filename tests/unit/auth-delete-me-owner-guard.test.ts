/**
 * OFFBOARD-1 — DELETE /auth/me refuses, in Egyptian Arabic, for an owner with a live billed store, and deactivates
 * nothing. A customer (owns no store) is never asked.
 */
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import express, { type Express } from 'express';
import request from 'supertest';

const h = vi.hoisted(() => ({
  auditLog: vi.fn(),
  billed: vi.fn(),
  setStatus: vi.fn(),
  withUser: vi.fn(),
  caller: { userId: 'owner-1', role: 'store_admin' },
}));

vi.mock('@ebda/database', () => ({
  prisma: {},
  withUser: (...a: unknown[]) => h.withUser(...a),
  withStore: vi.fn(),
  runInTenantContext: vi.fn(),
}));
vi.mock('@api/middleware/auth', async importOriginal => {
  const actual = await importOriginal<typeof import('@api/middleware/auth')>();
  return {
    ...actual,
    authenticate: (req: any, _res: any, next: any) => {
      req.user = { userId: h.caller.userId, role: h.caller.role };
      next();
    },
    rejectAdminOnMerchantOrigin: (_q: any, _s: any, n: any) => n(),
    rejectImpersonated: (_q: any, _s: any, n: any) => n(),
  };
});
vi.mock('@api/services/account-closure-guard', async importOriginal => {
  const actual = await importOriginal<typeof import('@api/services/account-closure-guard')>();
  return { ...actual, liveBilledStoresOf: (...a: unknown[]) => h.billed(...a) };
});
vi.mock('@api/lib/identity-client', async importOriginal => {
  const actual = await importOriginal<typeof import('@api/lib/identity-client')>();
  return {
    ...actual,
    isIdentityManagedUser: vi.fn(async () => true),
    setAccountStatus: (...a: unknown[]) => h.setStatus(...a),
  };
});
vi.mock('@api/lib/customer-auth', () => ({
  customerAuthRoute: vi.fn(async () => ({ kind: 'pg' })),
}));
vi.mock('@api/lib/wa/consent', () => ({ revokeForAccount: vi.fn() }));
vi.mock('@api/services/auth.service', () => ({
  AuthService: {},
  GENERIC_RESEND_VERIFICATION_RESULT: { success: true, message: '' },
}));
vi.mock('@api/middleware/security', () => {
  const pass = (_q: any, _s: any, n: any) => n();
  return {
    authLimiter: pass,
    authIpFailureLimiter: pass,
    authIpAllLimiter: pass,
    refreshLimiter: pass,
    refreshIpLimiter: pass,
    resetEmailLimiter: pass,
    authEmailAddressLimiter: pass,
    writeLimiter: pass,
    verifyEmailLimiter: pass,
    auditLog: h.auditLog,
    generateCsrfToken: vi.fn(() => 'csrf'),
  };
});
vi.mock('@api/lib/cors-cache', () => ({ isPlatformOrigin: vi.fn(() => true) }));
vi.mock('@api/services/redis.service', () => ({
  redis: { get: vi.fn(), set: vi.fn(), delete: vi.fn(), getClient: vi.fn(() => null) },
}));

let app: Express;
beforeAll(async () => {
  const { default: authRoutes } = await import('@api/routes/auth.routes');
  const { errorHandler } = await import('@api/middleware/error-handler');
  app = express();
  app.use(express.json());
  app.use('/api/v1/auth', authRoutes);
  app.use(errorHandler);
});
beforeEach(() => {
  vi.clearAllMocks();
  h.caller = { userId: 'owner-1', role: 'store_admin' };
  h.withUser.mockResolvedValue({ storeId: null, phone: null });
});

describe('DELETE /auth/me - owner with a live billed store (OFFBOARD-1)', () => {
  it('refuses with 409 and the Arabic message, and deactivates nothing', async () => {
    h.billed.mockResolvedValue(['store-1']);
    const res = await request(app).delete('/api/v1/auth/me');
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('OWNER_HAS_LIVE_BILLED_STORE');
    expect(res.body.error.message).toContain('اشتراك مدفوع');
    expect(h.setStatus).not.toHaveBeenCalled();
    expect(h.withUser).not.toHaveBeenCalled();
    expect(h.auditLog).not.toHaveBeenCalled();
  });

  it('an owner with no billed store still closes the account', async () => {
    h.billed.mockResolvedValue([]);
    const res = await request(app).delete('/api/v1/auth/me');
    expect(res.status).toBe(200);
    expect(h.setStatus).toHaveBeenCalledWith('owner-1', 'inactive', 'self-delete');
  });

  it('a customer is never checked (owns no store)', async () => {
    h.caller = { userId: 'cust-1', role: 'customer' };
    h.billed.mockResolvedValue(['store-1']);
    await request(app).delete('/api/v1/auth/me');
    expect(h.billed).not.toHaveBeenCalled();
  });
});
