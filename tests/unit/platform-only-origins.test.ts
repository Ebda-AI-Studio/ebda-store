/**
 * Platform-only origin gate (unit)
 *
 * Regression test for the 2026-09-02 adversarial audit P0-3.
 *
 * CORS runs with `credentials: true` and allowlists every custom merchant
 * domain by DB lookup, and the auth cookie is SameSite=None. The CSRF middleware
 * additionally exempted those same merchant origins, so a merchant could set
 * their store domain to a host they control, lure a logged-in super_admin there,
 * and issue credentialed calls whose responses their JS could read — including
 * POST /admin/impersonate, which mints a full-privilege token for any user.
 *
 * Removing the CSRF exemption closes the write half. This gate closes the read
 * half: CSRF only guards state-changing methods, so credentialed GETs from a
 * merchant origin would still have been readable.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Request, Response, NextFunction } from 'express';
import { restrictPlatformOnlyOrigins } from '../../apps/api/src/middleware/security';

function makeReq(origin: string | undefined, path: string, method = 'GET'): Request {
  return {
    headers: origin ? { origin } : {},
    path,
    method,
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

const PLATFORM_ORIGIN = 'https://admin.force-ai.co';
const MERCHANT_ORIGIN = 'https://attacker-owned-shop.example';

describe('restrictPlatformOnlyOrigins', () => {
  let next: NextFunction;

  beforeEach(() => {
    next = vi.fn();
  });

  it('blocks a merchant origin from the impersonation endpoint (the P0 chain)', () => {
    const res = makeRes();
    restrictPlatformOnlyOrigins(
      makeReq(MERCHANT_ORIGIN, '/api/v1/admin/impersonate', 'POST'),
      res,
      next
    );
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
    expect(res.body.error?.code).toBe('ORIGIN_NOT_PERMITTED');
  });

  it('blocks credentialed READS too, not just writes — CSRF would not have caught this', () => {
    const res = makeRes();
    restrictPlatformOnlyOrigins(makeReq(MERCHANT_ORIGIN, '/api/v1/admin/stores', 'GET'), res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
  });

  it.each(['/api/v1/admin/impersonate', '/api/v1/admin', '/api/v1/payment-settings/tap'])(
    'blocks a merchant origin on %s',
    path => {
      const res = makeRes();
      restrictPlatformOnlyOrigins(makeReq(MERCHANT_ORIGIN, path, 'POST'), res, next);
      expect(next).not.toHaveBeenCalled();
      expect(res.statusCode).toBe(403);
    }
  );

  it.each(['/api/v1/auth/me/erase', '/api/v1/auth/logout-all'])(
    'does NOT block %s — customer self-service, not platform admin',
    path => {
      // These read as "destructive, lock them down", but the storefront account
      // page calls /auth/me/erase and storefronts run on merchant custom
      // domains. Gating them here 403'd every customer erasing their own
      // account on a real merchant domain, breaking the GDPR Art. 17 / Kuwait
      // Law 13 path. They stay protected by authenticate + CSRF token +
      // rejectImpersonated, which is the right boundary for self-service.
      const res = makeRes();
      const localNext = vi.fn();
      restrictPlatformOnlyOrigins(
        makeReq(MERCHANT_ORIGIN, path, 'POST'),
        res,
        localNext as unknown as NextFunction
      );
      expect(localNext).toHaveBeenCalledOnce();
      expect(res.statusCode).toBe(0);
    }
  );

  it('lets the platform admin origin through', () => {
    const res = makeRes();
    restrictPlatformOnlyOrigins(
      makeReq(PLATFORM_ORIGIN, '/api/v1/admin/impersonate', 'POST'),
      res,
      next
    );
    expect(next).toHaveBeenCalledOnce();
    expect(res.statusCode).toBe(0);
  });

  it('does NOT touch storefront traffic from a merchant origin', () => {
    // Merchant storefronts on custom domains legitimately call the public and
    // per-store surfaces; this gate must not break them.
    for (const path of [
      '/api/v1/public/products',
      '/api/v1/public/cart/items',
      '/api/v1/stores/abc/orders',
    ]) {
      const res = makeRes();
      const localNext = vi.fn();
      restrictPlatformOnlyOrigins(makeReq(MERCHANT_ORIGIN, path, 'POST'), res, localNext);
      expect(localNext, `expected ${path} to pass`).toHaveBeenCalledOnce();
    }
  });

  it('allows a request with no Origin (server-to-server / CLI carry no ambient cookie)', () => {
    const res = makeRes();
    restrictPlatformOnlyOrigins(makeReq(undefined, '/api/v1/admin/impersonate', 'POST'), res, next);
    expect(next).toHaveBeenCalledOnce();
  });

  it('does not match a path that merely starts with the same characters', () => {
    const res = makeRes();
    restrictPlatformOnlyOrigins(
      makeReq(MERCHANT_ORIGIN, '/api/v1/administrative-notes', 'GET'),
      res,
      next
    );
    expect(next).toHaveBeenCalledOnce();
  });
});

describe('restrictPlatformOnlyOrigins — routing-shape bypasses', () => {
  // Express routes with caseSensitive:false and strict:false, so /ADMIN/ and a
  // trailing slash reach the real handler. A case-sensitive, slash-exact regex
  // would match NEITHER and the gate would fall through to next() — handing a
  // merchant origin exactly the credentialed cross-origin read it exists to
  // deny (GETs never reach the CSRF check either).
  it.each([
    '/api/v1/ADMIN/stores',
    '/api/v1/Admin/impersonate',
    '/api/v1/admin/',
    '/api/v1/payment-settings/',
    '/api/v1/PAYMENT-SETTINGS/tap',
  ])('still blocks a merchant origin on %s', path => {
    const res = makeRes();
    const localNext = vi.fn();
    restrictPlatformOnlyOrigins(
      makeReq(MERCHANT_ORIGIN, path, 'GET'),
      res,
      localNext as unknown as NextFunction
    );
    expect(localNext, `expected ${path} to be blocked`).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
  });

  it('does not throw on a malformed percent-escape', () => {
    const res = makeRes();
    const localNext = vi.fn();
    expect(() =>
      restrictPlatformOnlyOrigins(
        makeReq(MERCHANT_ORIGIN, '/api/v1/%zz/admin', 'GET'),
        res,
        localNext as unknown as NextFunction
      )
    ).not.toThrow();
  });
});
