/**
 * `rejectImpersonated` — the first and only reader of the `impersonatedBy`
 * claim that `POST /admin/impersonate` mints.
 *
 * The claim was documented as letting "downstream guards reject it for
 * high-privilege operations if desired", but for a long time nothing read it:
 * an impersonation session was indistinguishable from a real one and could
 * erase the impersonated person's account, change their password, or revoke
 * all their sessions. That is the amplifier that turned the merchant-custom-
 * origin CSRF hole into a full takeover — read one impersonation token, then
 * act irreversibly as anyone.
 *
 * The middleware shipped, but nothing pinned it. Two halves are tested here
 * and BOTH are load-bearing:
 *
 *   1. the middleware's own behaviour (403 vs pass-through), and
 *   2. that it is actually MOUNTED on every account-destructive auth route.
 *
 * Half 2 is the one that matters. A guard that exists but is not mounted is
 * the exact shape of the original bug, and a behaviour-only test passes
 * happily while every route is unguarded. Writing this test found precisely
 * that: `DELETE /auth/me` — soft-delete of the whole account — had never been
 * given the guard, while its three siblings had.
 */
import { describe, it, expect, vi } from 'vitest';
import type { Request, Response, NextFunction } from 'express';

vi.mock('@force/database', () => ({
  prisma: {
    user: { findFirst: vi.fn(), findUnique: vi.fn(), update: vi.fn() },
    store: { findFirst: vi.fn() },
  },
}));

vi.mock('@api/services/redis.service', () => ({
  redis: { get: vi.fn(), set: vi.fn(), delete: vi.fn(), getClient: vi.fn(() => null) },
}));

vi.mock('@api/services/auth.service', () => ({
  AuthService: {
    requestPasswordReset: vi.fn(),
    resendVerificationEmail: vi.fn(),
    updateProfile: vi.fn(),
    changePassword: vi.fn(),
    revokeAllSessions: vi.fn(),
  },
  GENERIC_RESEND_VERIFICATION_RESULT: { success: true, message: '' },
}));

vi.mock('@api/middleware/security', () => ({
  authLimiter: (_req: unknown, _res: unknown, next: () => void) => next(),
  refreshLimiter: (_req: unknown, _res: unknown, next: () => void) => next(),
  refreshIpLimiter: (_req: unknown, _res: unknown, next: () => void) => next(),
  auditLog: vi.fn(),
  generateCsrfToken: vi.fn(() => 'csrf'),
}));

vi.mock('@api/lib/cors-cache', () => ({ isPlatformOrigin: vi.fn(() => true) }));

// NOTE: `@api/middleware/auth` is deliberately NOT mocked. The mount
// assertions below compare against the REAL `rejectImpersonated` reference —
// a stub would make them pass against an unguarded router.
import { rejectImpersonated } from '@api/middleware/auth';
import authRoutes from '@api/routes/auth.routes';
import mfaRoutes from '@api/routes/mfa.routes';

function makeRes() {
  const recorded: { status: number; body: unknown } = { status: 200, body: undefined };
  const res = {
    status: (s: number) => {
      recorded.status = s;
      return res;
    },
    json: (b: unknown) => {
      recorded.body = b;
      return res;
    },
  };
  return { res: res as unknown as Response, recorded };
}

describe('rejectImpersonated — middleware behaviour', () => {
  it('403s with IMPERSONATION_FORBIDDEN when the token carries impersonatedBy', () => {
    const { res, recorded } = makeRes();
    const next = vi.fn() as unknown as NextFunction;
    const req = {
      user: { userId: 'victim-1', role: 'customer', impersonatedBy: 'admin-9' },
    } as unknown as Request;

    rejectImpersonated(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(recorded.status).toBe(403);
    expect(recorded.body).toMatchObject({
      success: false,
      error: { code: 'IMPERSONATION_FORBIDDEN' },
    });
  });

  it('calls next() for a normal authenticated session', () => {
    const { res, recorded } = makeRes();
    const next = vi.fn() as unknown as NextFunction;
    const req = { user: { userId: 'real-1', role: 'customer' } } as unknown as Request;

    rejectImpersonated(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(recorded.body).toBeUndefined();
  });

  it('calls next() for an unauthenticated request (authenticate owns that 401)', () => {
    const { res } = makeRes();
    const next = vi.fn() as unknown as NextFunction;
    rejectImpersonated({} as unknown as Request, res, next);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('rejects even when impersonatedBy is present alongside a privileged role', () => {
    const { res, recorded } = makeRes();
    const next = vi.fn() as unknown as NextFunction;
    const req = {
      user: { userId: 'victim-2', role: 'super_admin', impersonatedBy: 'admin-9' },
    } as unknown as Request;

    rejectImpersonated(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(recorded.status).toBe(403);
  });
});

interface RouteLayer {
  route?: {
    path: string;
    methods: Record<string, boolean>;
    stack: Array<{ handle: (...args: unknown[]) => unknown }>;
  };
}

type Router = { stack: RouteLayer[] };

const ROUTERS: Record<string, Router> = {
  // `/auth/*`
  auth: authRoutes as unknown as Router,
  // `/auth/mfa/*` — a SEPARATE router, mounted at routes/index.ts. The first
  // rollout of this registry walked only `authRoutes`, which made it
  // structurally blind to every MFA route; an audit found the hole rather than
  // this test. Qualifying each entry by router is what fixes that class, not
  // just the one route.
  mfa: mfaRoutes as unknown as Router,
};

function middlewareOn(
  router: string,
  method: string,
  path: string
): Array<(...a: unknown[]) => unknown> {
  const r = ROUTERS[router];
  if (!r) throw new Error(`Unknown router "${router}"`);
  const layer = r.stack.find(l => l.route?.path === path && l.route.methods[method]);
  if (!layer?.route) throw new Error(`Route ${method.toUpperCase()} ${router}:${path} not found`);
  return layer.route.stack.map(s => s.handle);
}

/**
 * Every route that irreversibly changes or destroys the ACCOUNT ITSELF, across
 * every router that owns one. Adding a new one WITHOUT the guard is the
 * regression this list exists to catch — so a new destructive route belongs
 * here the day it is written, and a new ROUTER belongs in `ROUTERS` above.
 */
const DESTRUCTIVE_ROUTES: Array<[string, string, string]> = [
  ['auth', 'post', '/logout-all'],
  ['auth', 'post', '/me/erase'],
  ['auth', 'post', '/change-password'],
  ['auth', 'delete', '/me'],
  // Binding a second factor to a victim with no MFA locks the owner out
  // permanently — no admin can undo it, unlike the soft-delete above.
  ['mfa', 'post', '/enroll/begin'],
  ['mfa', 'post', '/enroll/verify'],
  ['mfa', 'post', '/disable'],
];

describe('rejectImpersonated — mounted on every account-destructive route', () => {
  it.each(DESTRUCTIVE_ROUTES)('%s: %s %s carries the guard', (router, method, path) => {
    expect(middlewareOn(router, method, path)).toContain(rejectImpersonated);
  });

  it('is mounted AFTER authenticate, so req.user is populated when it reads the claim', () => {
    for (const [router, method, path] of DESTRUCTIVE_ROUTES) {
      const stack = middlewareOn(router, method, path);
      const guardAt = stack.indexOf(rejectImpersonated);
      const authAt = stack.findIndex(h => h.name === 'authenticate');
      const at = `${router}: ${method} ${path}`;
      expect(guardAt, `${at}: guard not mounted`).toBeGreaterThan(-1);
      expect(authAt, `${at}: authenticate not mounted`).toBeGreaterThan(-1);
      expect(authAt, `${at}: guard runs before authenticate`).toBeLessThan(guardAt);
    }
  });

  it('does NOT block non-destructive reads — impersonation is for looking', () => {
    // PUT /me edits name/phone only; support staff legitimately do this.
    expect(middlewareOn('auth', 'put', '/me')).not.toContain(rejectImpersonated);
    // `/auth/mfa/verify` is the pre-session challenge — there is no
    // `req.user` yet, so it is correctly excluded rather than overlooked.
    expect(middlewareOn('mfa', 'post', '/verify')).not.toContain(rejectImpersonated);
  });
});
