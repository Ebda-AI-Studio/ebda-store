/**
 * Review M4. A merchant-controlled page (custom domain / store host) is CORS-allowed with credentials, so it
 * can lure a signed-in ADMIN and read account endpoints with the admin's cookie. `/auth/me` (name, email,
 * role, MFA state), the data export, and now the passkey list were all reachable that way (PRE-EXISTING for
 * `/auth/me`, found while reviewing passkeys). Rule: an admin-namespace identity (store_admin, staff,
 * super_admin) is only served to PLATFORM origins; a shopper (`customer`) is the only role the storefront
 * origins legitimately carry.
 */
import { describe, it, expect, vi } from 'vitest';
import type { Request, Response, NextFunction } from 'express';

vi.mock('@ebda/database', () => ({
  prisma: {
    user: { findFirst: vi.fn(), findUnique: vi.fn(), update: vi.fn() },
    store: { findFirst: vi.fn() },
  },
}));
vi.mock('@api/services/redis.service', () => ({
  redis: { get: vi.fn(), set: vi.fn(), delete: vi.fn(), getClient: vi.fn(() => null) },
}));
vi.mock('@api/services/auth.service', () => ({
  AuthService: {},
  GENERIC_RESEND_VERIFICATION_RESULT: { success: true, message: '' },
}));
vi.mock('@api/middleware/security', () => {
  const pass = (_q: unknown, _s: unknown, n: () => void) => n();
  return {
    authLimiter: pass,
    authIpFailureLimiter: pass,
    authIpAllLimiter: pass,
    refreshLimiter: pass,
    refreshIpLimiter: pass,
    resetEmailLimiter: pass,
    authEmailAddressLimiter: pass,
    verifyEmailLimiter: pass,
    writeLimiter: pass,
    passkeyBeginLimiter: pass,
    passkeyFinishLimiter: pass,
    passkeyStepUpLimiter: pass,
    auditLog: vi.fn(),
    generateCsrfToken: vi.fn(() => 'csrf'),
  };
});
// NOT mocked: isPlatformOrigin is the real decision.
import { rejectAdminOnMerchantOrigin } from '@api/middleware/auth';
import authRoutes from '@api/routes/auth.routes';
import mfaRoutes from '@api/routes/mfa.routes';
import passkeyRoutes from '@api/routes/passkey.routes';

const ADMIN = process.env.ADMIN_URL || 'http://localhost:3001';
const run = (role: string, origin: string | undefined) => {
  const next = vi.fn();
  let status = 200;
  let body: any;
  const res = {
    status: (s: number) => ((status = s), res),
    json: (b: unknown) => ((body = b), res),
  } as unknown as Response;
  const mw = rejectAdminOnMerchantOrigin as (r: Request, s: Response, n: NextFunction) => void;
  mw(
    { user: { userId: 'u', role }, headers: { origin } } as unknown as Request,
    res,
    next as never
  );
  return { next, status, body };
};

describe('rejectAdminOnMerchantOrigin', () => {
  it.each(['store_admin', 'staff', 'super_admin'])('refuses %s on a merchant origin', role => {
    const r = run(role, 'https://merchant-shop.example');
    expect(r.next).not.toHaveBeenCalled();
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe('ORIGIN_NOT_PERMITTED');
  });
  it('refuses an admin on a slug store host too', () => {
    expect(run('store_admin', 'https://shop-a.ebda.app').next).not.toHaveBeenCalled();
  });
  it('serves the admin on the admin (platform) origin', () => {
    expect(run('store_admin', ADMIN).next).toHaveBeenCalledOnce();
  });
  it('serves a shopper on a merchant origin: that is what the storefront is for', () => {
    expect(run('customer', 'https://merchant-shop.example').next).toHaveBeenCalledOnce();
  });
  it('lets a request with no Origin through (server-to-server carries no ambient cookie)', () => {
    expect(run('store_admin', undefined).next).toHaveBeenCalledOnce();
  });
});

interface Layer {
  route?: { path: string; methods: Record<string, boolean>; stack: Array<{ handle: unknown }> };
}
const stackOf = (router: unknown, method: string, path: string) => {
  const l = (router as { stack: Layer[] }).stack.find(
    x => x.route?.path === path && x.route.methods[method]
  );
  if (!l?.route) throw new Error(`route not found ${method} ${path}`);
  return l.route.stack.map(s => s.handle);
};

describe('the guard is mounted on every authenticated account endpoint', () => {
  const ROUTES: Array<[string, unknown, string, string]> = [
    ['auth', authRoutes, 'get', '/me'],
    ['auth', authRoutes, 'put', '/me'],
    ['auth', authRoutes, 'delete', '/me'],
    ['auth', authRoutes, 'get', '/me/export'],
    ['auth', authRoutes, 'post', '/me/erase'],
    ['auth', authRoutes, 'post', '/change-password'],
    ['auth', authRoutes, 'post', '/logout-all'],
    ['mfa', mfaRoutes, 'post', '/enroll/begin'],
    ['mfa', mfaRoutes, 'post', '/enroll/verify'],
    ['mfa', mfaRoutes, 'post', '/disable'],
    ['passkeys', passkeyRoutes, 'get', '/'],
    ['passkeys', passkeyRoutes, 'post', '/step-up'],
    ['passkeys', passkeyRoutes, 'post', '/register/begin'],
    ['passkeys', passkeyRoutes, 'post', '/register/finish'],
    ['passkeys', passkeyRoutes, 'patch', '/:id'],
    ['passkeys', passkeyRoutes, 'delete', '/:id'],
  ];

  it.each(ROUTES)('%s %s %s', (_name, router, method, path) => {
    const stack = stackOf(router, method, path);
    const authAt = stack.findIndex(h => (h as { name?: string }).name === 'authenticate');
    const guardAt = stack.indexOf(rejectAdminOnMerchantOrigin);
    expect(authAt).toBeGreaterThan(-1);
    expect(guardAt, 'guard missing').toBeGreaterThan(-1);
    expect(guardAt).toBeGreaterThan(authAt);
  });
});
