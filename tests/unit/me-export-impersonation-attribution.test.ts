/**
 * #1718 — GET /auth/me/export is deliberately NOT guarded by
 * rejectImpersonated (Ruling IMP-1, docs/RULINGS.md: read-only, blocking it
 * needs a separate decision this batch doesn't make). What ships here is the
 * minimum that doesn't require that decision: an impersonated download
 * writes `impersonatedBy` into its own audit row, so it is at least
 * attributable rather than indistinguishable from the account owner's own
 * export.
 */
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import express, { type Express } from 'express';
import request from 'supertest';

const h = vi.hoisted(() => ({
  exportAccount: vi.fn(),
  auditLog: vi.fn(),
  caller: { userId: 'user-1', role: 'customer', impersonatedBy: undefined as string | undefined },
}));

vi.mock('@ebda/database', async importOriginal => {
  const actual = await importOriginal<typeof import('@ebda/database')>();
  return { ...actual, prisma: {} };
});

vi.mock('@api/middleware/auth', async importOriginal => {
  const actual = await importOriginal<typeof import('@api/middleware/auth')>();
  return {
    ...actual,
    authenticate: (req: any, _res: any, next: any) => {
      req.user = {
        userId: h.caller.userId,
        role: h.caller.role,
        ...(h.caller.impersonatedBy ? { impersonatedBy: h.caller.impersonatedBy } : {}),
      };
      next();
    },
  };
});

vi.mock('@api/services/auth.service', () => ({
  AuthService: { exportAccount: h.exportAccount },
  GENERIC_RESEND_VERIFICATION_RESULT: { success: true, message: '' },
}));
vi.mock('@api/middleware/security', () => ({
  authLimiter: (_req: any, _res: any, next: any) => next(),
  authIpFailureLimiter: (_req: unknown, _res: unknown, next: () => void) => next(),
  authIpAllLimiter: (_req: unknown, _res: unknown, next: () => void) => next(),
  authIpFailureLimiter: (_req: any, _res: any, next: any) => next(),
  authIpAllLimiter: (_req: any, _res: any, next: any) => next(),
  refreshLimiter: (_req: any, _res: any, next: any) => next(),
  refreshIpLimiter: (_req: any, _res: any, next: any) => next(),
  resetEmailLimiter: (_req: any, _res: any, next: any) => next(),
  authEmailAddressLimiter: (_req: any, _res: any, next: any) => next(),
  writeLimiter: (_req: any, _res: any, next: any) => next(),
  // #1863: /verify-email got its own limiter instead of sharing authLimiter's
  // <ip>-unknown bucket with /reset-password.
  verifyEmailLimiter: (_req: any, _res: any, next: any) => next(),
  auditLog: h.auditLog,
  generateCsrfToken: vi.fn(() => 'csrf'),
}));
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
  h.caller = { userId: 'user-1', role: 'customer', impersonatedBy: undefined };
  h.exportAccount.mockResolvedValue({ account: {} });
});

describe('GET /auth/me/export — impersonation attribution', () => {
  it('a normal session audits with no impersonatedBy in details', async () => {
    const res = await request(app).get('/api/v1/auth/me/export');
    expect(res.status).toBe(200);
    const call = h.auditLog.mock.calls[0][0];
    expect(call.action).toBe('user.data.exported');
    expect(call.details).toBeUndefined();
  });

  it('an impersonated session still succeeds (not blocked — Ruling IMP-1) but audits impersonatedBy', async () => {
    h.caller = { userId: 'victim-1', role: 'customer', impersonatedBy: 'admin-9' };
    const res = await request(app).get('/api/v1/auth/me/export');
    expect(res.status).toBe(200);
    expect(h.exportAccount).toHaveBeenCalledWith('victim-1', undefined);
    const call = h.auditLog.mock.calls[0][0];
    expect(call.action).toBe('user.data.exported');
    expect(call.details).toEqual({ impersonatedBy: 'admin-9' });
  });
});
