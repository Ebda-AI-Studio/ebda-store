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
import { csrfProtection } from '@api/middleware/security';

const MERCHANT_ORIGIN = 'https://merchant-owned-shop.example';

function makeReq(
  path: string,
  opts: { origin?: string; method?: string; headers?: Record<string, string> } = {}
) {
  return {
    path,
    method: opts.method ?? 'POST',
    headers: {
      'content-type': 'application/json',
      ...(opts.origin ? { origin: opts.origin } : {}),
      ...(opts.headers ?? {}),
    },
  } as unknown as Request;
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
