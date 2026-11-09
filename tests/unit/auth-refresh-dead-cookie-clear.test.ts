/**
 * #1531 — POST /auth/refresh clears DEAD session cookies even when no refresh
 * token can be presented.
 *
 * The 401 branch already clears the cookies of a session that no longer
 * exists. But a browser holding a `token` cookie and NO refresh token (a
 * session minted before rotating refresh tokens shipped, or one whose
 * `refresh_token` partner is gone) never reached it: the `!refreshToken` 400
 * returned first. With a 365-day maxAge, that browser stayed "signed in" to
 * csrfProtection, the cookieless guest branch never fired, and POST
 * /payments/create 403'd permanently.
 *
 * The other half matters as much: a caller with NO session cookie must get no
 * Set-Cookie at all, and a transient (non-401) failure must never sign anyone
 * out.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockRefreshTokens } = vi.hoisted(() => ({ mockRefreshTokens: vi.fn() }));

vi.mock('@api/services/auth.service', () => ({
  AuthService: { refreshTokens: (...a: unknown[]) => mockRefreshTokens(...a) },
  GENERIC_RESEND_VERIFICATION_RESULT: { success: true, message: 'x' },
}));
vi.mock('@ebda/database', () => ({ prisma: {} }));
vi.mock('@api/middleware/security', () => ({
  authLimiter: (_req: unknown, _res: unknown, next: () => void) => next(),
  authIpFailureLimiter: (_req: unknown, _res: unknown, next: () => void) => next(),
  authIpAllLimiter: (_req: unknown, _res: unknown, next: () => void) => next(),
  verifyEmailLimiter: (_req: unknown, _res: unknown, next: () => void) => next(),
  refreshLimiter: (_req: unknown, _res: unknown, next: () => void) => next(),
  refreshIpLimiter: (_req: unknown, _res: unknown, next: () => void) => next(),
  resetEmailLimiter: (_req: unknown, _res: unknown, next: () => void) => next(),
  authEmailAddressLimiter: (_req: unknown, _res: unknown, next: () => void) => next(),
  auditLog: vi.fn(),
  generateCsrfToken: vi.fn(() => 'csrf'),
  // #1801: `/auth/refresh` verifies the presented token's signature before
  // querying Neon. Every case in this file presents a shaped-but-arbitrary
  // token and expects the route to reach `AuthService.refreshTokens` (mocked
  // above), so this must return truthy rather than actually verify a JWT.
  verifyRefreshJwt: vi.fn(() => ({ sub: 'test' })),
}));
vi.mock('@api/middleware/auth', () => ({
  authenticate: (_req: unknown, _res: unknown, next: () => void) => next(),
  rejectImpersonated: (_req: unknown, _res: unknown, next: () => void) => next(),
  rejectIdentityManaged: (_req: unknown, _res: unknown, next: () => void) => next(),
  authenticateAccounts: vi.fn(),
  rejectAdminOnMerchantOrigin: (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock('@api/services/redis.service', () => ({
  redis: { get: vi.fn(), set: vi.fn(), delete: vi.fn(), getClient: vi.fn(() => null) },
}));
vi.mock('@api/lib/cors-cache', () => ({ isPlatformOrigin: vi.fn(() => true) }));

import authRoutes from '@api/routes/auth.routes';
import { AppError } from '@api/middleware/error-handler';

interface RouteLayer {
  route?: {
    path: string;
    methods: Record<string, boolean>;
    stack: Array<{ handle: (...args: unknown[]) => unknown }>;
  };
}

function refreshHandler() {
  const layers = (authRoutes as unknown as { stack: RouteLayer[] }).stack;
  const layer = layers.find(l => l.route?.path === '/refresh' && l.route.methods.post);
  if (!layer?.route) throw new Error('POST /refresh not found');
  const stack = layer.route.stack;
  return stack[stack.length - 1].handle as (
    req: unknown,
    res: unknown,
    next: (err?: unknown) => void
  ) => Promise<void>;
}

function call(cookies: Record<string, string> | undefined, body: unknown = {}) {
  const cleared: string[] = [];
  const recorded: { status: number; body: unknown } = { status: 200, body: undefined };
  const res = {
    clearCookie: (name: string) => {
      cleared.push(name);
      return res;
    },
    cookie: vi.fn(() => res),
    json: (b: unknown) => {
      recorded.body = b;
      return res;
    },
    status: (s: number) => {
      recorded.status = s;
      return res;
    },
  };
  const next = vi.fn();
  const req = { body, cookies, headers: {} };
  return { run: () => refreshHandler()(req, res, next), cleared, recorded, next };
}

describe('POST /auth/refresh — dead session cookies are cleared (#1531)', () => {
  beforeEach(() => {
    mockRefreshTokens.mockReset();
  });

  it('a `token` cookie with no refresh token: 401 NO_REFRESH_TOKEN AND both session cookies cleared', async () => {
    const c = call({ token: 'stale-access-jwt' });
    await c.run();
    expect(c.recorded.status).toBe(401);
    expect(c.recorded.body).toMatchObject({ error: { code: 'NO_REFRESH_TOKEN' } });
    expect(c.cleared.sort()).toEqual(['refresh_token', 'token']);
    expect(mockRefreshTokens).not.toHaveBeenCalled();
  });

  it('no session cookie at all: 401 NO_REFRESH_TOKEN with NO Set-Cookie (a cookieless guest is left alone)', async () => {
    for (const cookies of [undefined, {}, { sessionId: 'x' }]) {
      const c = call(cookies);
      await c.run();
      expect(c.recorded.status).toBe(401);
      expect(c.recorded.body).toMatchObject({ error: { code: 'NO_REFRESH_TOKEN' } });
      expect(c.cleared).toEqual([]);
    }
  });

  it('a refresh the service rejects as 401 still clears (the existing heal)', async () => {
    mockRefreshTokens.mockRejectedValue(new AppError(401, 'INVALID_REFRESH_TOKEN', 'nope'));
    const c = call({ refresh_token: 'revoked' });
    await c.run();
    expect(c.cleared.sort()).toEqual(['refresh_token', 'token']);
    expect(c.next).toHaveBeenCalled();
  });

  it('a transient failure never signs the user out', async () => {
    mockRefreshTokens.mockRejectedValue(new Error('database unreachable'));
    const c = call({ token: 't', refresh_token: 'r' });
    await c.run();
    expect(c.cleared).toEqual([]);
  });
});
