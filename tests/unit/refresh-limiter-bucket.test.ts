/**
 * `/auth/refresh` must not share a rate-limit bucket with everything else that
 * has no email in its body.
 *
 * `authLimiter`'s key is `<ip>-<req.body.email>`. A refresh body is `{}` or
 * `{refreshToken}` and never carries an email, so every refresh from an IP
 * collapsed into ONE bucket — `<ip>-unknown` — shared with `/mfa/verify` and
 * the password-reset confirm routes, which are emailless for the same reason.
 * Measured in production 2026-09-10: 46 sessions for one user refreshing in a
 * single second after a deploy. Fifteen got through; the rest got 429, and
 * both clients read a non-ok refresh as a dead session.
 *
 * This suite executes the key function. It has to: `skipForLoadTestOrTests` is
 * `isTestEnv || …`, so the limiters are fully disabled under vitest and no
 * test that drives the route can ever observe a 429. A suite that asserted on
 * the route would be green against a bucket that does not exist.
 */

import { describe, it, expect, vi } from 'vitest';
import jwt from 'jsonwebtoken';
import type { Request } from 'express';
import { refreshLimiterKey } from '@api/middleware/security';

const IP = '203.0.113.7';

function req(over: Partial<Request> = {}): Request {
  return { ip: IP, body: {}, cookies: {}, ...over } as unknown as Request;
}

// A REAL refresh token: same secret, algorithm, issuer and audience
// `AuthService.generateTokens` uses. The key generator verifies the signature
// before it trusts `sub`, so a token minted any other way is (correctly) not a
// token for `sub` at all.
const tokenFor = (sub: string) =>
  jwt.sign({ type: 'refresh' }, process.env.JWT_SECRET as string, {
    algorithm: 'HS256',
    issuer: 'force-api',
    audience: 'force-app',
    subject: sub,
    expiresIn: '365d',
  });

describe('refresh bucket is per user, not per IP', () => {
  it('gives two users on the SAME ip different buckets', () => {
    const a = refreshLimiterKey(req({ body: { refreshToken: tokenFor('user-a') } }));
    const b = refreshLimiterKey(req({ body: { refreshToken: tokenFor('user-b') } }));

    expect(a).not.toBe(b);
  });

  it('gives the same user the SAME bucket across tabs', () => {
    // The point of the budget: one user's open tabs share it. Two tabs holding
    // two different tokens for the same account must land together, or the
    // ceiling means nothing.
    const tab1 = refreshLimiterKey(req({ body: { refreshToken: tokenFor('user-a') } }));
    const tab2 = refreshLimiterKey(req({ cookies: { refresh_token: tokenFor('user-a') } }));

    expect(tab1).toBe(tab2);
  });

  it('reads the token from the refresh_token cookie when the body is empty', () => {
    // The pure-browser path sends `{}` and lets the server read the cookie.
    // A key that only looked at the body would put every cookie-path refresh
    // in the shared anonymous bucket — which is the bug, restored.
    const cookie = refreshLimiterKey(req({ cookies: { refresh_token: tokenFor('user-a') } }));

    expect(cookie).not.toBe(refreshLimiterKey(req()));
    expect(cookie).toContain('user-a');
  });

  it('does not collapse an emailless body into the shared `unknown` bucket', () => {
    // The exact shape of the regression: `authLimiter` keyed on
    // `req.body.email || 'unknown'`, and a refresh body has no email.
    const key = refreshLimiterKey(req({ body: { refreshToken: tokenFor('user-a') } }));

    expect(key).not.toContain('unknown');
    expect(key).toContain('refresh');
  });

  it('does not run crypto over an oversized body', async () => {
    // The ceiling's whole purpose is that the HMAC never happens: JSON bodies
    // are accepted up to 10mb, and verifying a 10mb "token" once per request
    // IS the amplifier the limiter exists to prevent. Asserting the resulting
    // bucket would pass without the guard too (an oversized string fails
    // verification anyway), so this asserts the thing the guard actually does
    // — that `jwt.verify` is never reached.
    const jwtModule = (await import('jsonwebtoken')).default;
    const spy = vi.spyOn(jwtModule, 'verify');

    const oversized = 'a'.repeat(5000);
    const key = refreshLimiterKey(req({ body: { refreshToken: oversized } }));

    expect(spy).not.toHaveBeenCalled();
    expect(key).toContain('anon');
    spy.mockRestore();
  });

  it('still runs crypto over a normally sized token', () => {
    // The positive control. A ceiling set low enough to reject real tokens
    // would satisfy the test above and break every legitimate refresh.
    const key = refreshLimiterKey(req({ body: { refreshToken: tokenFor('user-a') } }));

    expect(key).toContain('user-a');
  });

  it('falls back to one anonymous bucket for a token it cannot parse', () => {
    // Unparseable tokens are what brute force looks like; they share the
    // strict bucket rather than each minting their own.
    const junk1 = refreshLimiterKey(req({ body: { refreshToken: 'not-a-jwt' } }));
    const junk2 = refreshLimiterKey(req({ body: { refreshToken: 'also-not-a-jwt' } }));

    expect(junk1).toBe(junk2);
    expect(junk1).toContain('anon');
  });

  it('does NOT let an unsigned token choose its own bucket', () => {
    // The whole point of a rate limiter is that the CALLER does not pick the
    // partition. `jwt.decode` would read `sub` straight out of a blob the
    // caller composed, so `jwt.sign({}, 'wrong-secret', {subject: uuid()})` in
    // a loop mints a fresh 120-per-15-min budget per request and is never
    // throttled — while each request still costs a sha256 + a Neon
    // `refreshToken.findUnique` before any signature is checked.
    const forged = Array.from({ length: 5 }, (_, i) =>
      refreshLimiterKey(
        req({
          body: {
            refreshToken: jwt.sign({ type: 'refresh' }, 'attacker-secret', {
              issuer: 'force-api',
              audience: 'force-app',
              subject: `forged-${i}`,
            }),
          },
        })
      )
    );

    expect(new Set(forged).size, 'forged subjects must not partition the bucket').toBe(1);
    expect(forged[0]).toContain('anon');
    expect(forged[0]).not.toContain('forged-');
  });

  it('sends an EXPIRED token to the anonymous bucket', () => {
    // Verification is signature AND lifetime. An expired token is dead to the
    // route, so it gets the strict bucket rather than a private one.
    const expired = jwt.sign({ type: 'refresh' }, process.env.JWT_SECRET as string, {
      algorithm: 'HS256',
      issuer: 'force-api',
      audience: 'force-app',
      subject: 'user-a',
      expiresIn: -60,
    });

    expect(refreshLimiterKey(req({ body: { refreshToken: expired } }))).toContain('anon');
  });

  it('does not HMAC an oversized body masquerading as a token', () => {
    // `express.json({limit:'10mb'})` means the "token" can be 10mb, and
    // verifying one costs an HMAC over the whole thing — the key generator
    // would become the amplifier. Anything past the ceiling is anon, uncrypted.
    const huge = 'a'.repeat(5000);

    expect(refreshLimiterKey(req({ body: { refreshToken: huge } }))).toContain('anon');
  });

  it('still separates the same user on different ips', () => {
    const here = refreshLimiterKey(req({ body: { refreshToken: tokenFor('user-a') } }));
    const there = refreshLimiterKey(
      req({ ip: '198.51.100.9', body: { refreshToken: tokenFor('user-a') } })
    );

    expect(here).not.toBe(there);
  });
});

/**
 * …and the route actually uses it.
 *
 * A correct bucket wired to nothing is the same as no bucket. This reads the
 * COMPOSED router — the middleware stack Express will really run — rather than
 * grepping the source for a name, because the characters being present is not
 * evidence that the route uses them.
 */
describe('POST /auth/refresh is wired to the refresh bucket', () => {
  it('carries refreshLimiter and no longer carries authLimiter', async () => {
    const { authLimiter, refreshLimiter } = await import('@api/middleware/security');
    const authRoutes = (await import('@api/routes/auth.routes')).default as unknown as {
      stack: Array<{ route?: { path: string; stack: Array<{ handle: unknown }> } }>;
    };

    const refreshLayer = authRoutes.stack.find(l => l.route?.path === '/refresh');
    expect(refreshLayer, 'POST /auth/refresh not found on the auth router').toBeTruthy();

    const handlers = refreshLayer!.route!.stack.map(s => s.handle);
    expect(handlers).toContain(refreshLimiter);
    expect(handlers).not.toContain(authLimiter);
  });

  it('also carries the IP-wide backstop, ahead of the per-subject bucket', async () => {
    // `refreshLimiter` partitions by subject, so its ceiling is
    // 120 × (subjects seen from this IP) — not a constant. And
    // `skipGlobalRateLimit` exempts POST /auth/refresh from the global
    // mutation cap, so if this layer is missing the route has NO IP-wide
    // ceiling at all.
    const { refreshLimiter, refreshIpLimiter } = await import('@api/middleware/security');
    const authRoutes = (await import('@api/routes/auth.routes')).default as unknown as {
      stack: Array<{ route?: { path: string; stack: Array<{ handle: unknown }> } }>;
    };

    const handlers = authRoutes.stack
      .find(l => l.route?.path === '/refresh')!
      .route!.stack.map(s => s.handle);

    expect(handlers).toContain(refreshIpLimiter);
    expect(handlers.indexOf(refreshIpLimiter)).toBeLessThan(handlers.indexOf(refreshLimiter));
  });

  it('leaves /login on authLimiter — credential stuffing is still its problem', () => {
    // The positive control for the assertion above: if every route had been
    // swapped, or if `stack` were empty and `toContain` were vacuous, this
    // would fail too.
    return import('@api/routes/auth.routes').then(async m => {
      const { authLimiter } = await import('@api/middleware/security');
      const routes = m.default as unknown as {
        stack: Array<{ route?: { path: string; stack: Array<{ handle: unknown }> } }>;
      };
      const login = routes.stack.find(l => l.route?.path === '/login');
      expect(login!.route!.stack.map(s => s.handle)).toContain(authLimiter);
    });
  });
});
