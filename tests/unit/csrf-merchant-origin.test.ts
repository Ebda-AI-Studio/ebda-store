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
import { csrfProtection, generateCsrfToken } from '@api/middleware/security';
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
      issuer: 'force-api',
      audience: 'force-app',
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
      makeReq('/api/v1/stores/abc/reviews', { origin: MERCHANT_ORIGIN }),
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

  it('still exempts /auth/ and Bearer-authenticated requests', () => {
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

    it('rejects a token minted for a signed-in user when the request carries no cookie', async () => {
      const token = await generateCsrfToken(SESSION, ATTACKER);

      const { res, next } = await runCsrf(
        makeReq('/api/v1/stores/own-tenant/products', {
          origin: MERCHANT_ORIGIN,
          headers: { 'x-session-id': SESSION, 'x-csrf-token': token },
        })
      );

      expect(next).not.toHaveBeenCalled();
      expect(res.body.error?.code).toBe('CSRF_INVALID');
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
