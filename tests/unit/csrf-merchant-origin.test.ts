/**
 * csrfProtection after the merchant-origin exemption was removed.
 *
 * The exemption let any DB-registered merchant custom domain skip the CSRF
 * token check, which is what allowed a merchant-controlled page to ride a
 * logged-in super_admin's cookie. Removing it is correct — but it changes the
 * contract for every non-`/public/` storefront write, and the original PR
 * shipped with only a `restrictPlatformOnlyOrigins` test, so nothing exercised
 * `csrfProtection` itself.
 *
 * That gap hid a P0: ReviewSection.tsx submitted reviews with a raw `fetch`
 * that sent neither X-Session-ID nor X-CSRF-Token, so product-review
 * submission would have 403'd on every merchant custom domain — i.e. for every
 * real merchant, permanently, while still working on the platform origin where
 * it would have been tested.
 *
 * These tests pin the exemption's removal AND the early-exit paths that keep
 * guest checkout working, so neither can regress silently.
 */

import { describe, it, expect, vi } from 'vitest';
import type { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { csrfProtection, generateCsrfToken, isCsrfExemptAuthPath } from '@api/middleware/security';
import { config } from '@api/config';

const MERCHANT_ORIGIN = 'https://merchant-owned-shop.example';

function makeReq(
  path: string,
  opts: {
    origin?: string;
    method?: string;
    headers?: Record<string, string>;
    cookies?: Record<string, string>;
  } = {}
) {
  return {
    path,
    method: opts.method ?? 'POST',
    cookies: opts.cookies ?? {},
    headers: {
      'content-type': 'application/json',
      ...(opts.origin ? { origin: opts.origin } : {}),
      ...(opts.headers ?? {}),
    },
  } as unknown as Request;
}

/** An access cookie exactly as login/refresh mint it, for `userId`. */
function accessCookieFor(userId: string): string {
  return jwt.sign(
    { userId, email: `${userId}@example.test`, role: 'customer', tv: 0 },
    config.jwtSecret,
    {
      expiresIn: '30m',
      issuer: 'ebda-api',
      audience: 'ebda-app',
    }
  );
}

function makeRes() {
  const res = {
    statusCode: 0,
    body: undefined as unknown,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      this.body = payload;
      return this;
    },
  };
  return res as unknown as Response & { statusCode: number; body: { error?: { code?: string } } };
}

describe('csrfProtection — merchant origins are no longer exempt', () => {
  it('rejects a cookie-authed write from a merchant origin with no CSRF headers', () => {
    const res = makeRes();
    const next = vi.fn();
    csrfProtection(
      // Carries the auth cookie its name claims: that is what makes this a
      // CSRF-relevant request. With no cookie there is no credential for a
      // cross-origin page to ride, and the guard deliberately lets it through.
      makeReq('/api/v1/stores/abc/reviews', {
        origin: MERCHANT_ORIGIN,
        cookies: { token: 'victim.jwt.value' },
      }),
      res,
      next as unknown as NextFunction
    );

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
    expect(res.body.error?.code).toBe('CSRF_MISSING_SESSION');
  });

  it('still exempts /public/ — guest cart and checkout must keep working', () => {
    // This is the early return that makes removing the merchant exemption safe
    // for guests, who never hold a CSRF token.
    for (const path of [
      '/api/v1/public/orders',
      '/api/v1/public/cart/items',
      '/api/v1/public/reviews/submit',
    ]) {
      const res = makeRes();
      const next = vi.fn();
      csrfProtection(
        makeReq(path, { origin: MERCHANT_ORIGIN }),
        res,
        next as unknown as NextFunction
      );
      expect(next, `expected ${path} to pass`).toHaveBeenCalledOnce();
    }
  });

  it('S2: /public/ writes carrying an auth cookie are NOT exempt (cookie-auth POST /public/orders)', () => {
    for (const cookies of [{ token: 'victim.jwt' }, { refresh_token: 'victim.refresh' }]) {
      const res = makeRes();
      const next = vi.fn();
      csrfProtection(
        makeReq('/api/v1/public/orders', { origin: MERCHANT_ORIGIN, cookies }),
        res,
        next as unknown as NextFunction
      );
      expect(next).not.toHaveBeenCalled();
      expect(res.statusCode).toBe(403);
      expect(res.body.error?.code).toBe('CSRF_MISSING_SESSION');
    }
  });

  it('still exempts the credential-less /auth/ entry points and Bearer-authenticated requests', () => {
    const res1 = makeRes();
    const n1 = vi.fn();
    csrfProtection(
      makeReq('/api/v1/auth/login', { origin: MERCHANT_ORIGIN }),
      res1,
      n1 as unknown as NextFunction
    );
    expect(n1).toHaveBeenCalledOnce();

    const res2 = makeRes();
    const n2 = vi.fn();
    csrfProtection(
      makeReq('/api/v1/stores/abc/reviews', {
        origin: MERCHANT_ORIGIN,
        headers: { authorization: 'Bearer abc.def.ghi' },
      }),
      res2,
      n2 as unknown as NextFunction
    );
    expect(n2).toHaveBeenCalledOnce();
  });

  /**
   * The token is a double-submit secret, so the verifier must answer "was this
   * minted for the identity making the request", not merely "does this token
   * exist for the session id you claim". Both the session id and the token are
   * attacker-supplied headers: an attacker registers a throwaway customer,
   * logs in with an X-Session-ID it picks (POST /auth/login is exempt from
   * csrfProtection and mints for any id), and hardcodes the resulting pair
   * into a page on its CORS-allowlisted merchant domain. A lured super_admin's
   * SameSite=None cookie then rides along and the write executes as the
   * victim. Only the principal binding rejects it — restrictPlatformOnlyOrigins
   * covers /admin + /payment-settings, not /stores/:id/*.
   */
  describe('CSRF tokens are bound to the principal they were minted for', () => {
    const ATTACKER = 'attacker-user-id';
    const VICTIM = 'victim-super-admin-id';
    const SESSION = 'attacker-chosen-session-id';

    function runCsrf(req: Request) {
      const res = makeRes();
      const next = vi.fn();
      return new Promise<{ res: typeof res; next: typeof next }>(resolve => {
        const done = () => resolve({ res, next });
        next.mockImplementation(done);
        const originalJson = res.json.bind(res);
        (res as unknown as { json: (p: unknown) => unknown }).json = (payload: unknown) => {
          const out = originalJson(payload);
          done();
          return out;
        };
        csrfProtection(req, res, next as unknown as NextFunction);
      });
    }

    it('rejects a pair minted in the attacker session but replayed on the victim cookie', async () => {
      const token = await generateCsrfToken(SESSION, ATTACKER);

      const { res, next } = await runCsrf(
        makeReq('/api/v1/stores/other-tenant/products', {
          origin: MERCHANT_ORIGIN,
          headers: { 'x-session-id': SESSION, 'x-csrf-token': token },
          cookies: { token: accessCookieFor(VICTIM) },
        })
      );

      expect(next).not.toHaveBeenCalled();
      expect(res.statusCode).toBe(403);
      expect(res.body.error?.code).toBe('CSRF_INVALID');
    });

    it('accepts the same pair when the cookie identifies the user it was minted for', async () => {
      const token = await generateCsrfToken(SESSION, ATTACKER);

      const { next } = await runCsrf(
        makeReq('/api/v1/stores/own-tenant/products', {
          origin: MERCHANT_ORIGIN,
          headers: { 'x-session-id': SESSION, 'x-csrf-token': token },
          cookies: { token: accessCookieFor(ATTACKER) },
        })
      );

      expect(next).toHaveBeenCalledOnce();
    });

    it('lets a cookieless request through, because it has no credential to ride', async () => {
      // CSRF exists to stop a malicious page making the browser attach a
      // VICTIM's credentials. A request with no auth cookie carries none, and
      // an attacker can call such an endpoint straight from their own server
      // without a browser at all -- so requiring a token here protects nothing
      // and only breaks the callers who cannot obtain one.
      //
      // Those callers are the whole guest storefront: cart, coupon validate,
      // shipping/tax calculate, promotions preview and POST /payments/create
      // are unauthenticated by design, and `generateCsrfToken` is reachable
      // only from login and refresh. Requiring a token from them 403'd every
      // guest card payment on demo-store.example for two days.
      //
      // The impersonation case this replaced stays covered above by 'rejects a
      // pair minted in the attacker session but replayed on the victim cookie',
      // which is the attack that actually needs a victim.
      const token = await generateCsrfToken(SESSION, ATTACKER);

      const { next } = await runCsrf(
        makeReq('/api/v1/payments/create', {
          origin: MERCHANT_ORIGIN,
          headers: { 'x-session-id': SESSION, 'x-csrf-token': token },
        })
      );

      expect(next).toHaveBeenCalledOnce();
    });
  });

  it('does not gate safe methods', () => {
    const res = makeRes();
    const next = vi.fn();
    csrfProtection(
      makeReq('/api/v1/stores/abc/reviews', { origin: MERCHANT_ORIGIN, method: 'GET' }),
      res,
      next as unknown as NextFunction
    );
    expect(next).toHaveBeenCalledOnce();
  });
});

/**
 * The cookieless short-circuit must not fire on an UNPARSED request.
 *
 * `if (!req.cookies?.token && !req.cookies?.refresh_token) return next();`
 * evaluates TRUE when `req.cookies` is undefined — not empty, never parsed —
 * so every state-changing request skipped CSRF, silently. The only thing
 * preventing it was `cookieParser` being mounted ahead of `csrfProtection`.
 *
 * These EXECUTE the middleware rather than asserting on its source text: a
 * source-grep proves the characters are present, not that the branch behaves.
 */
describe('csrfProtection — the cookieless short-circuit fails CLOSED', () => {
  it('does NOT wave through a request whose cookies were never parsed', () => {
    const res = makeRes();
    const next = vi.fn();
    // `cookies` deliberately absent — this is a request that reached
    // csrfProtection before (or without) cookieParser.
    const req = {
      path: '/api/v1/stores/abc/reviews',
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: MERCHANT_ORIGIN },
    } as unknown as Request;

    csrfProtection(req, res, next as unknown as NextFunction);

    // The precise assertion is "not silently exempted". Whether it 403s or
    // falls to the token verifier is the implementation's business; skipping
    // the gate entirely is the defect.
    expect(next).not.toHaveBeenCalledWith();
  });

  it('still exempts a genuinely cookieless request — guest checkout must work', () => {
    // The narrow case the short-circuit exists for: cookies PARSED, and empty.
    // Breaking this would break guest checkout on merchant custom domains.
    const res = makeRes();
    const next = vi.fn();
    csrfProtection(
      makeReq('/api/v1/stores/abc/payments/create', { origin: MERCHANT_ORIGIN, cookies: {} }),
      res,
      next as unknown as NextFunction
    );
    expect(next).toHaveBeenCalled();
    expect(res.statusCode).toBe(0);
  });
});

/**
 * Issue 2425 — `/auth/` is no longer a blanket CSRF exemption.
 *
 * The blanket `req.path.includes('/auth/')` skip was justified as "auth
 * endpoints use JWT tokens (not session cookies)", which is false for every
 * route behind `authenticate`: they ride the same SameSite=None cookie as any
 * store write, and a merchant custom domain is CORS-allowlisted. A page on a
 * host the merchant controls could flip a visiting shopper's SMS consent,
 * change their profile, or delete their account with the victim's cookie.
 */
describe('csrfProtection — only the credential-less /auth/ routes are exempt (issue 2425)', () => {
  const VICTIM = 'victim-shopper-id';
  const SESSION = 'victim-session-id';

  function runCsrf(req: Request) {
    const res = makeRes();
    const next = vi.fn();
    return new Promise<{ res: typeof res; next: typeof next }>(resolve => {
      const done = () => resolve({ res, next });
      next.mockImplementation(done);
      const originalJson = res.json.bind(res);
      (res as unknown as { json: (p: unknown) => unknown }).json = (payload: unknown) => {
        const out = originalJson(payload);
        done();
        return out;
      };
      csrfProtection(req, res, next as unknown as NextFunction);
    });
  }

  // Every state-changing route behind `authenticate` under /auth/.
  const AUTHENTICATED_WRITES: Array<[string, string]> = [
    ['PUT', '/api/v1/auth/me/sms-consent'],
    ['PUT', '/api/v1/auth/me'],
    ['DELETE', '/api/v1/auth/me'],
    ['POST', '/api/v1/auth/me/erase'],
    ['POST', '/api/v1/auth/change-password'],
    ['POST', '/api/v1/auth/logout-all'],
    ['POST', '/api/v1/auth/mfa/enroll/begin'],
    ['POST', '/api/v1/auth/mfa/enroll/verify'],
    ['POST', '/api/v1/auth/mfa/disable'],
    // Passkeys: registering/renaming/removing is an authenticated write (PASSKEY-1..6).
    ['POST', '/api/v1/auth/passkeys/step-up'],
    ['POST', '/api/v1/auth/passkeys/register/begin'],
    ['POST', '/api/v1/auth/passkeys/register/finish'],
    ['PATCH', '/api/v1/auth/passkeys/00000000-0000-4000-8000-000000000000'],
    ['DELETE', '/api/v1/auth/passkeys/00000000-0000-4000-8000-000000000000'],
  ];

  it.each(AUTHENTICATED_WRITES)(
    'refuses a forged cross-site %s %s riding the victim cookie',
    async (method, path) => {
      const { res, next } = await runCsrf(
        makeReq(path, {
          method,
          origin: MERCHANT_ORIGIN,
          cookies: { token: accessCookieFor(VICTIM) },
        })
      );
      expect(next).not.toHaveBeenCalled();
      expect(res.statusCode).toBe(403);
      expect(res.body.error?.code).toBe('CSRF_MISSING_SESSION');
    }
  );

  it('still lets the signed-in shopper on a custom domain through with their own token', async () => {
    const token = await generateCsrfToken(SESSION, VICTIM);
    const { next } = await runCsrf(
      makeReq('/api/v1/auth/me/sms-consent', {
        method: 'PUT',
        origin: MERCHANT_ORIGIN,
        headers: { 'x-session-id': SESSION, 'x-csrf-token': token },
        cookies: { token: accessCookieFor(VICTIM) },
      })
    );
    expect(next).toHaveBeenCalledOnce();
  });

  const EXEMPT = [
    '/api/v1/auth/register',
    '/api/v1/auth/login',
    '/api/v1/auth/refresh',
    '/api/v1/auth/logout',
    '/api/v1/auth/forgot-password',
    '/api/v1/auth/reset-password',
    '/api/v1/auth/verify-email',
    '/api/v1/auth/resend-verification',
    '/api/v1/auth/mfa/verify',
    // Passkey sign-in is credential-less like /login.
    '/api/v1/auth/passkeys/authenticate/begin',
    '/api/v1/auth/passkeys/authenticate/finish',
  ];

  it.each(EXEMPT)('keeps %s exempt, even with a cookie present', async path => {
    for (const spelling of [path, `${path}/`, path.toUpperCase()]) {
      const { next } = await runCsrf(
        makeReq(spelling, { origin: MERCHANT_ORIGIN, cookies: { token: accessCookieFor(VICTIM) } })
      );
      expect(next, spelling).toHaveBeenCalledOnce();
    }
  });

  it('matches whole paths, not substrings', () => {
    for (const p of [
      '/api/v1/auth/login/extra',
      '/api/v1/auth/me',
      '/api/v1/stores/x/auth/login',
      '/api/v1/auth/',
      '/api/v1/auth/loginx',
    ]) {
      expect(isCsrfExemptAuthPath(p), p).toBe(false);
    }
  });

  it('exempts exactly the routes the storefront treats as credential-less (no drift)', async () => {
    const { endpointMayRefresh } = await import('@web/lib/api');
    for (const p of EXEMPT) {
      expect(isCsrfExemptAuthPath(p), p).toBe(true);
      expect(endpointMayRefresh(p.replace('/api/v1', '')), p).toBe(false);
    }
    for (const [, p] of AUTHENTICATED_WRITES) {
      expect(isCsrfExemptAuthPath(p), p).toBe(false);
      expect(endpointMayRefresh(p.replace('/api/v1', '')), p).toBe(true);
    }
  });
});
