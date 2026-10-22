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
    issuer: 'ebda-api',
    audience: 'ebda-app',
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
  it('rotates the live cookie instead when a stale body token 401s (same user)', async () => {
    const stale = realToken('user-a');
    const live = realToken('user-a');
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
    // Issue 2170: the caller's stored copy is now dead — say so, or its next
    // refresh presents a rotated token and revokes the whole family.
    expect(body.data.staleRefreshToken).toBe(true);
  });

  it('neither rotates NOR clears a live cookie for a cross-site form posting garbage (issue 1962)', async () => {
    const live = realToken('live');
    mockRefreshTokens.mockImplementation(async (t: string) => {
      if (t === live) return ROTATED;
      throw invalid();
    });
    const t = run({ body: { refreshToken: 'garbage' }, cookies: { refresh_token: live } });
    await t.go();

    // The garbage proved nothing about the cookie session: it is not rotated
    // (that desynced iOS clients into a family revoke) and not cleared.
    expect(mockRefreshTokens).not.toHaveBeenCalledWith(live);
    expect(t.cleared).toEqual([]);
    expect(t.next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 401 }));
  });

  it('never rotates a cookie that belongs to a DIFFERENT user than the body token (issue 1962)', async () => {
    const mine = realToken('user-a');
    const someoneElse = realToken('user-b');
    mockRefreshTokens.mockImplementation(async (t: string) => {
      if (t === someoneElse) return ROTATED;
      throw invalid();
    });
    const t = run({ body: { refreshToken: mine }, cookies: { refresh_token: someoneElse } });
    await t.go();

    expect(mockRefreshTokens).not.toHaveBeenCalledWith(someoneElse);
    expect(t.cleared).toEqual([]);
    expect(t.res.json).not.toHaveBeenCalled();
    expect(t.next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 401 }));
  });

  it('a dead body token + an UNVERIFIABLE cookie still clears the cookie (#1531 heal)', async () => {
    const t = run({
      body: { refreshToken: realToken('user-a') },
      cookies: { refresh_token: 'not-a-jwt' },
    });
    await t.go();
    expect(t.cleared.sort()).toEqual(['refresh_token', 'token']);
  });

  it('stale body token + dead cookie token -> cookies cleared', async () => {
    // The iOS WebKit clients always post their localStorage token in the body
    // with the cookies alongside. When the whole session is dead, the dead
    // cookies must still go, or the cookieless guest checkout branch never
    // fires and POST /payments/create 403s permanently.
    const t = run({
      body: { refreshToken: realToken('user-a') },
      cookies: { refresh_token: realToken('user-a') },
    });
    await t.go();

    expect(t.next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 401 }));
    expect(t.cleared.sort()).toEqual(['refresh_token', 'token']);
  });

  it('keeps the cookies when the cookie retry fails TRANSIENTLY (not a sign-out)', async () => {
    const live = realToken('user-a');
    mockRefreshTokens.mockImplementation(async (t: string) => {
      if (t === live) throw new Error('database unreachable');
      throw invalid();
    });
    const t = run({
      body: { refreshToken: realToken('user-a') },
      cookies: { refresh_token: live },
    });
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
        issuer: 'ebda-api',
        audience: 'ebda-app',
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
      issuer: 'ebda-api',
      audience: 'ebda-app',
      subject: 'user-a',
      expiresIn: -60,
    });
    await run({ body: { refreshToken: realToken() } }).go();
    await run({ body: { refreshToken: expired } }).go();

    expect(mockRefreshTokens).toHaveBeenCalledTimes(2);
  });
});

// Issue 2217: a BODY token is caller-supplied, and this route is CSRF-exempt
// with credentialed CORS for every merchant domain — so writing Set-Cookie for
// whatever token was posted let a merchant-origin page install the ATTACKER's
// session into the victim's browser.
describe('issue 2217 — the body lane never installs a caller-chosen session as cookies', () => {
  function withOrigin(origin: string | undefined, body: string, cookie?: string) {
    const t = run({
      body: { refreshToken: body },
      ...(cookie ? { cookies: { refresh_token: cookie } } : {}),
    });
    return {
      ...t,
      go: () =>
        refreshHandler()(
          {
            headers: origin ? { origin } : {},
            body: { refreshToken: body },
            cookies: cookie ? { refresh_token: cookie } : {},
          },
          t.res,
          t.next
        ),
    };
  }

  beforeEach(() => mockRefreshTokens.mockResolvedValue(ROTATED));

  it('a merchant-origin body token that is not the browser cookie: pair in the body, NO Set-Cookie', async () => {
    const attackers = realToken('attacker');
    const t = withOrigin('https://merchant.example', attackers, realToken('victim'));
    await t.go();
    expect(t.res.cookie).not.toHaveBeenCalled();
    const body = t.res.json.mock.calls[0][0] as { data: Record<string, unknown> };
    expect(body.data.refreshToken).toBe('new-refresh');
  });

  it('no cookie at all on a merchant origin: still no Set-Cookie', async () => {
    const t = withOrigin('https://merchant.example', realToken('attacker'));
    await t.go();
    expect(t.res.cookie).not.toHaveBeenCalled();
  });

  it('the iOS client whose body token IS its cookie keeps getting both cookies rotated', async () => {
    const same = realToken('user-a');
    const t = withOrigin('https://merchant.example', same, same);
    await t.go();
    expect(t.res.cookie).toHaveBeenCalledTimes(2);
  });

  it('a platform origin keeps getting the cookies', async () => {
    const { config } = await import('@api/config');
    const t = withOrigin(config.adminUrl, realToken('user-a'));
    await t.go();
    expect(t.res.cookie).toHaveBeenCalledTimes(2);
  });

  it('the ambient-cookie lane (no body token) always rotates its cookies', async () => {
    const t = run({ cookies: { refresh_token: realToken('user-a') } });
    await t.go();
    expect(t.res.cookie).toHaveBeenCalledTimes(2);
  });
});
