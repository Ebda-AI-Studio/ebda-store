/**
 * P1-1 — Prisma filter injection / enumeration oracle on the two
 * UNAUTHENTICATED auth lookup routes.
 *
 * `POST /auth/forgot-password` and `POST /auth/resend-verification` took
 * `req.body.email` with a TRUTHINESS check only (unlike register/login on the
 * same router, which are Zod-parsed) and passed it straight into
 * `authScope(email, storeId)` → a Prisma `where`. Prisma accepts a StringFilter
 * OBJECT there, so `{"email":{"not":"zzz"}}` or `{"email":{"startsWith":"a"}}`
 * matched a REAL user: the attacker learned an account exists, and
 * forgot-password actually MAILED that real customer a real reset link — while
 * the endpoint's own enumeration defences (DUMMY_PASSWORD_HASH, the
 * both-branches bcrypt, the silent no-user return) went on working perfectly
 * for the input shape they were designed for.
 *
 * `sanitizeInput` does not help: `sanitizeObject` recurses into nested objects
 * and PRESERVES their keys, so the filter arrives at Prisma intact.
 *
 * FM-5 is the trap this test also guards: the fix must NOT turn a malformed
 * email into a distinguishable 400, because the always-generic response IS the
 * enumeration defence. A filter object and an unknown-but-valid email must
 * produce BYTE-IDENTICAL bodies.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockRequestPasswordReset = vi.fn();
const mockResendVerificationEmail = vi.fn();
const mockUserFindFirst = vi.fn();

vi.mock('@api/services/auth.service', async () => {
  // The real module is imported for GENERIC_RESEND_VERIFICATION_RESULT so the
  // route and the service cannot drift on the generic body — only the two
  // lookup methods are stubbed.
  return {
    AuthService: {
      requestPasswordReset: (...a: unknown[]) => mockRequestPasswordReset(...a),
      resendVerificationEmail: (...a: unknown[]) => mockResendVerificationEmail(...a),
    },
    GENERIC_RESEND_VERIFICATION_RESULT: {
      success: true,
      message: 'If an account exists with this email, a verification link has been sent.',
    },
  };
});

vi.mock('@ebda/database', () => ({
  prisma: { user: { findFirst: (...a: unknown[]) => mockUserFindFirst(...a) } },
}));

vi.mock('@api/middleware/security', () => ({
  authLimiter: (_req: unknown, _res: unknown, next: () => void) => next(),
  refreshLimiter: (_req: unknown, _res: unknown, next: () => void) => next(),
  refreshIpLimiter: (_req: unknown, _res: unknown, next: () => void) => next(),
  // S5-3, 2026-09-22 security audit: auth.routes.ts now imports this too.
  resetEmailLimiter: (_req: unknown, _res: unknown, next: () => void) => next(),
  authEmailAddressLimiter: (_req: unknown, _res: unknown, next: () => void) => next(),
  // #1863: /verify-email got its own limiter instead of sharing authLimiter's
  // <ip>-unknown bucket with /reset-password.
  verifyEmailLimiter: (_req: unknown, _res: unknown, next: () => void) => next(),
  auditLog: vi.fn(),
  generateCsrfToken: vi.fn(() => 'csrf'),
}));

vi.mock('@api/middleware/auth', () => ({
  authenticate: (_req: unknown, _res: unknown, next: () => void) => next(),
  rejectImpersonated: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

vi.mock('@api/services/redis.service', () => ({
  redis: { get: vi.fn(), set: vi.fn(), delete: vi.fn(), getClient: vi.fn(() => null) },
}));

vi.mock('@api/lib/cors-cache', () => ({ isPlatformOrigin: vi.fn(() => true) }));

// Ruling B1-13: the routes refuse the demo store first; not this suite's concern (it is pinned in
// tests/integration/demo-store.test.ts), and the real guard needs the database this suite mocks.
vi.mock('@api/services/plan-limit.service', () => ({ assertNotDemoStore: vi.fn(async () => {}) }));

import authRoutes from '@api/routes/auth.routes';

interface RouteLayer {
  route?: {
    path: string;
    methods: Record<string, boolean>;
    stack: Array<{ handle: (...args: unknown[]) => unknown }>;
  };
}

function getHandler(method: 'post', path: string) {
  const layers = (authRoutes as unknown as { stack: RouteLayer[] }).stack;
  const layer = layers.find(l => l.route?.path === path && l.route.methods[method]);
  if (!layer?.route) throw new Error(`Route ${method.toUpperCase()} ${path} not found`);
  const stack = layer.route.stack;
  return stack[stack.length - 1].handle as (
    req: unknown,
    res: unknown,
    next: (err?: unknown) => void
  ) => Promise<void>;
}

/** Captures the exact status + body a handler produced, for byte comparison. */
function capture(body: unknown) {
  const recorded: { status: number; body: unknown } = { status: 200, body: undefined };
  const res = {
    json: (b: unknown) => {
      recorded.body = b;
      return res;
    },
    status: (s: number) => {
      recorded.status = s;
      return res;
    },
  };
  return { req: { body }, res, recorded, next: vi.fn() };
}

describe('POST /auth/forgot-password — enumeration oracle closed', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRequestPasswordReset.mockResolvedValue(undefined);
  });

  it('NEVER passes a Prisma filter object to the service', async () => {
    const handler = getHandler('post', '/forgot-password');
    const { req, res, next } = capture({ email: { not: 'zzz' } });

    await handler(req, res, next);

    // The whole exploit: this call used to happen with the filter object,
    // which matched a real user and mailed them a real reset link.
    expect(mockRequestPasswordReset).not.toHaveBeenCalled();
  });

  it('returns a BYTE-IDENTICAL body for a filter object and an unknown-but-valid email (FM-5)', async () => {
    const handler = getHandler('post', '/forgot-password');

    const valid = capture({ email: 'nobody@example.test' });
    await handler(valid.req, valid.res, valid.next);

    const filter = capture({ email: { not: 'zzz' } });
    await handler(filter.req, filter.res, filter.next);

    const startsWith = capture({ email: { startsWith: 'a' } });
    await handler(startsWith.req, startsWith.res, startsWith.next);

    const garbage = capture({ email: 'not-an-email' });
    await handler(garbage.req, garbage.res, garbage.next);

    expect(filter.recorded).toEqual(valid.recorded);
    expect(startsWith.recorded).toEqual(valid.recorded);
    expect(garbage.recorded).toEqual(valid.recorded);
    expect(valid.recorded.status).toBe(200);
  });

  it('still 400s on a missing email, byte-identical to before the fix', async () => {
    const handler = getHandler('post', '/forgot-password');
    const { req, res, recorded, next } = capture({});

    await handler(req, res, next);

    expect(recorded.status).toBe(400);
    expect(recorded.body).toEqual({
      success: false,
      error: { code: 'VALIDATION_ERROR', message: 'Email is required' },
    });
  });

  it('still works for a legitimate email', async () => {
    const handler = getHandler('post', '/forgot-password');
    const { req, res, next } = capture({ email: 'real@example.test', storeId: 'store-1' });

    await handler(req, res, next);

    expect(mockRequestPasswordReset).toHaveBeenCalledWith('real@example.test', 'store-1');
  });
});

describe('POST /auth/resend-verification — enumeration oracle closed', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockResendVerificationEmail.mockResolvedValue({
      success: true,
      message: 'If an account exists with this email, a verification link has been sent.',
    });
  });

  it('NEVER passes a Prisma filter object to the service', async () => {
    const handler = getHandler('post', '/resend-verification');
    const { req, res, next } = capture({ email: { startsWith: 'a' } });

    await handler(req, res, next);

    expect(mockResendVerificationEmail).not.toHaveBeenCalled();
  });

  it('returns a BYTE-IDENTICAL body for a filter object and an unknown-but-valid email (FM-5)', async () => {
    const handler = getHandler('post', '/resend-verification');

    const valid = capture({ email: 'nobody@example.test' });
    await handler(valid.req, valid.res, valid.next);

    const filter = capture({ email: { startsWith: 'a' } });
    await handler(filter.req, filter.res, filter.next);

    expect(filter.recorded).toEqual(valid.recorded);
    expect(valid.recorded.status).toBe(200);
  });

  it('still 400s on a missing email, byte-identical to before the fix', async () => {
    const handler = getHandler('post', '/resend-verification');
    const { req, res, recorded, next } = capture({});

    await handler(req, res, next);

    expect(recorded.status).toBe(400);
    expect(recorded.body).toEqual({
      success: false,
      error: { code: 'VALIDATION_ERROR', message: 'Email is required' },
    });
  });

  it('still works for a legitimate email', async () => {
    const handler = getHandler('post', '/resend-verification');
    const { req, res, next } = capture({ email: 'real@example.test' });

    await handler(req, res, next);

    expect(mockResendVerificationEmail).toHaveBeenCalledWith('real@example.test', null);
  });
});
