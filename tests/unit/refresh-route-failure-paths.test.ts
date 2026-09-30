/**
 * POST /auth/refresh — two failure-path defences on the route handler.
 *
 * #1527: a failed BODY token never clears a live cookie session. When a body
 * token fails and a different cookie token is present, the route retries with
 * the cookie; cookies are cleared only when that also fails on authentication. `express.urlencoded` is global and csrfProtection
 * skips /auth/, so a cross-site auto-submitting form posting
 * `refreshToken=garbage` rides the victim's SameSite=None cookies and 401s on
 * the garbage; clearing there destroyed a session that was never tried. The
 * iOS admin PWA hits the same path innocently with a stale localStorage token.
 *
 * #1801: the route verifies the token's signature BEFORE the service hashes it
 * and queries Neon, so garbage costs an HMAC, not an unauthenticated DB trip.
 *
 * The handler is driven directly (the limiters in front of it are disabled
 * under vitest anyway); `AuthService.refreshTokens` is the stubbed DB edge.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import jwt from 'jsonwebtoken';

const mockRefreshTokens = vi.fn();

vi.mock('@api/services/auth.service', () => ({
  AuthService: {
    refreshTokens: (...a: unknown[]) => mockRefreshTokens(...a),
  },
  GENERIC_RESEND_VERIFICATION_RESULT: { success: true, message: 'x' },
}));

import authRoutes from '@api/routes/auth.routes';
import { AppError } from '@api/middleware/error-handler';

interface RouteLayer {
  route?: { path: string; methods: Record<string, boolean>; stack: Array<{ handle: unknown }> };
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

/** A token with a VALID signature, as AuthService.generateTokens mints them. */
const realToken = (sub = 'user-a') =>
  jwt.sign({ type: 'refresh' }, process.env.JWT_SECRET as string, {
    algorithm: 'HS256',
    issuer: 'force-api',
    audience: 'force-app',
    subject: sub,
    expiresIn: '365d',
    jwtid: `${Math.random()}`,
  });

function run(req: { body?: Record<string, unknown>; cookies?: Record<string, string> }) {
  const cleared: string[] = [];
  const res = {
    clearCookie: (name: string) => {
      cleared.push(name);
      return res;
    },
    cookie: vi.fn(() => res),
    json: vi.fn(() => res),
    status: vi.fn(() => res),
  };
  const next = vi.fn();
  const fullReq = { headers: {}, body: {}, cookies: {}, ...req };
  return { go: () => refreshHandler()(fullReq, res, next), cleared, next, res };
}

beforeEach(() => {
  vi.clearAllMocks();
  // The DB says: this token does not exist (revoked / rotated away / unknown).
  mockRefreshTokens.mockRejectedValue(new AppError(401, 'TOKEN_INVALID', 'Invalid refresh token'));
});

const ROTATED = { accessToken: 'new-access', refreshToken: 'new-refresh' };
const invalid = () => new AppError(401, 'TOKEN_INVALID', 'Invalid refresh token');

describe('#1527 a failed BODY-token refresh never clears a LIVE cookie session', () => {
  it('rotates the live cookie instead when a stale body token 401s', async () => {
    const stale = realToken('stale');
    const live = realToken('live');
    mockRefreshTokens.mockImplementation(async (t: string) => {
      if (t === live) return ROTATED;
      throw invalid();
    });
    const t = run({ body: { refreshToken: stale }, cookies: { refresh_token: live } });
    await t.go();

    expect(t.next).not.toHaveBeenCalled();
    expect(t.cleared).toEqual([]);
    expect(mockRefreshTokens).toHaveBeenLastCalledWith(live);
    // Rotated as an ambient-cookie caller: Set-Cookie only, no tokens in the body.
    const body = t.res.json.mock.calls[0][0] as { data: Record<string, unknown> };
    expect(body.data.refreshed).toBe(true);
    expect(body.data.accessToken).toBeUndefined();
    expect(body.data.refreshToken).toBeUndefined();
  });

  it('does not clear a live cookie session for a cross-site form posting garbage', async () => {
    const live = realToken('live');
    mockRefreshTokens.mockImplementation(async (t: string) => {
      if (t === live) return ROTATED;
      throw invalid();
    });
    const t = run({ body: { refreshToken: 'garbage' }, cookies: { refresh_token: live } });
    await t.go();

    expect(t.next).not.toHaveBeenCalled();
    expect(t.cleared).toEqual([]);
  });

  it('stale body token + dead cookie token -> cookies cleared', async () => {
    // The iOS WebKit clients always post their localStorage token in the body
    // with the cookies alongside. When the whole session is dead, the dead
    // cookies must still go, or the cookieless guest checkout branch never
    // fires and POST /payments/create 403s permanently.
    const t = run({
      body: { refreshToken: realToken('stale') },
      cookies: { refresh_token: realToken('dead') },
    });
    await t.go();

    expect(t.next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 401 }));
    expect(t.cleared.sort()).toEqual(['refresh_token', 'token']);
  });

  it('keeps the cookies when the cookie retry fails TRANSIENTLY (not a sign-out)', async () => {
    const live = realToken('live');
    mockRefreshTokens.mockImplementation(async (t: string) => {
      if (t === live) throw new Error('database unreachable');
      throw invalid();
    });
    const t = run({ body: { refreshToken: realToken('stale') }, cookies: { refresh_token: live } });
    await t.go();

    expect(t.cleared).toEqual([]);
  });

  it('control: a dead COOKIE session is still cleared (the case the clear exists for)', async () => {
    const t = run({ cookies: { refresh_token: realToken('dead') } });
    await t.go();

    expect(t.next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 401 }));
    expect(t.cleared.sort()).toEqual(['refresh_token', 'token']);
  });
});

describe('#1801 the route verifies the signature before touching the database', () => {
  it('never reaches the DB-backed rotation for a token that does not verify', async () => {
    for (const bad of [
      'junk',
      jwt.sign({ type: 'refresh' }, 'attacker-secret', {
        issuer: 'force-api',
        audience: 'force-app',
        subject: 'forged',
      }),
      'a'.repeat(5000),
    ]) {
      const t = run({ body: { refreshToken: bad } });
      await t.go();
      expect(t.next).toHaveBeenCalledWith(
        expect.objectContaining({ statusCode: 401, code: 'TOKEN_INVALID' })
      );
    }
    expect(mockRefreshTokens).not.toHaveBeenCalled();
  });

  it('still reaches it for a genuine token, including one whose JWT exp has passed', async () => {
    // Lifetime is the DB row's call (REFRESH_TOKEN_EXPIRES_IN can be shorter
    // than the row), so an expired-but-signed token must still be looked up.
    const expired = jwt.sign({ type: 'refresh' }, process.env.JWT_SECRET as string, {
      algorithm: 'HS256',
      issuer: 'force-api',
      audience: 'force-app',
      subject: 'user-a',
      expiresIn: -60,
    });
    await run({ body: { refreshToken: realToken() } }).go();
    await run({ body: { refreshToken: expired } }).go();

    expect(mockRefreshTokens).toHaveBeenCalledTimes(2);
  });
});
