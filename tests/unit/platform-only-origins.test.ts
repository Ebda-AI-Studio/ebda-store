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
import { readdirSync, readFileSync } from 'fs';
import path from 'path';
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
      // account on a real merchant domain, breaking the GDPR Art. 17 /
      // applicable GCC data-protection law path. They stay protected by
      // authenticate + CSRF token +
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
      // NOT '/stores/abc/orders' — that was written here as an assumed
      // storefront path before apps/web/src was actually enumerated. The
      // storefront never calls the order COLLECTION; it calls the per-order
      // timeline. The collection is the merchant-admin order list carrying
      // customer PII, and is now correctly denied.
      '/api/v1/stores/abc/orders/order-1/timeline',
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

/**
 * Everything under /stores is denied to merchant origins except the
 * storefront's own calls.
 *
 * This started as a DENY-list of enumerated admin segments and that was the
 * wrong direction. It missed `shipments` (customer names, addresses, phones),
 * `coupons` (full codes and values), `loyalty`, `promotions`, and
 * `/orders/:id/invoice` — the last because the orders pattern deliberately
 * stopped at one segment to spare `/timeline`, which let the admin-only
 * invoice through with the customer's full name, address and line items. Forty
 * routers mount under /stores; a deny-list is only as complete as whoever last
 * enumerated them, and nobody redoes that when the forty-first lands.
 *
 * Inverted, a missed admin route fails CLOSED — a visible 403 on an admin
 * surface — instead of open, which is a silent cross-origin PII read.
 */
describe('restrictPlatformOnlyOrigins — /stores is deny-by-default', () => {
  it.each([
    // Every surface the 2026-09-03 audit named as leaking, plus the ones the
    // first version did catch, so a regression to a deny-list is loud.
    ['/api/v1/stores/store-1/shipments', 'customer names, addresses, phones'],
    ['/api/v1/stores/store-1/coupons', 'full coupon codes and values'],
    ['/api/v1/stores/store-1/loyalty', 'customer loyalty balances'],
    ['/api/v1/stores/store-1/promotions', 'unpublished promotions'],
    ['/api/v1/stores/store-1/orders/order-1/invoice', 'full customer PII + line items'],
    ['/api/v1/stores/store-1/orders', 'the admin order list'],
    ['/api/v1/stores/store-1/orders/order-1', 'admin order detail'],
    ['/api/v1/stores/store-1/customers', 'the customer list'],
    ['/api/v1/stores/store-1/analytics/dashboard', 'revenue analytics'],
    ['/api/v1/stores/store-1/finance/accounts', 'the chart of accounts'],
    ['/api/v1/stores/store-1/suppliers', 'supplier records'],
    ['/api/v1/stores/store-1/staff', 'staff accounts'],
    ['/api/v1/stores/store-1/reviews/rev-1/moderate', 'review moderation, NOT a storefront read'],
    ['/api/v1/stores/store-1', 'the store record — MFA-gated admin read'],
    ['/api/v1/stores/store-1/products', 'admin product list: costPrice, drafts, sold-units'],
    ['/api/v1/stores/store-1/products/prod-1', 'admin product detail'],
    ['/api/v1/stores/store-1/anything-invented-tomorrow', 'a route that does not exist yet'],
  ])('blocks a credentialed merchant-origin GET on %s (%s)', path => {
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
});

describe('restrictPlatformOnlyOrigins — the storefront must keep working', () => {
  const STOREFRONT_CALLS = [
    ['/api/v1/stores/public/store-1/shipping', 'CheckoutClient — shipping zones'],
    ['/api/v1/stores/public/store-1/shipping/calculate', 'CheckoutClient — shipping cost'],
    ['/api/v1/stores/public/store-1/shipping/area-rates', 'CheckoutClient — area rates'],
    ['/api/v1/stores/public/store-1/coupons/validate', 'CheckoutClient + CartClient'],
    ['/api/v1/stores/public/store-1/promotions/preview', 'CheckoutClient'],
    ['/api/v1/stores/store-1/orders/order-1/timeline', 'lib/api.ts — order tracking'],
    ['/api/v1/stores/store-1/returns', 'ReturnsClient.tsx'],
    ['/api/v1/stores/store-1/reviews', 'ReviewSection.tsx — submit'],
    ['/api/v1/stores/store-1/reviews/product/prod-1', 'ReviewSection.tsx — list'],
    ['/api/v1/stores/store-1/reviews/can-review/prod-1', 'ReviewSection.tsx — eligibility'],
  ] as const;

  it.each(STOREFRONT_CALLS)('lets %s through (%s)', path => {
    const res = makeRes();
    const localNext = vi.fn();
    restrictPlatformOnlyOrigins(
      makeReq(MERCHANT_ORIGIN, path, 'POST'),
      res,
      localNext as unknown as NextFunction
    );
    expect(
      localNext,
      `expected ${path} to PASS — blocking it breaks the storefront on every merchant custom domain`
    ).toHaveBeenCalledOnce();
    expect(res.statusCode).toBe(0);
  });

  it('the order timeline is allowed while the list, detail and invoice are not', () => {
    const verdicts = [
      '/api/v1/stores/store-1/orders',
      '/api/v1/stores/store-1/orders/order-1',
      '/api/v1/stores/store-1/orders/order-1/invoice',
      '/api/v1/stores/store-1/orders/order-1/timeline',
    ].map(path => {
      const localNext = vi.fn();
      restrictPlatformOnlyOrigins(
        makeReq(MERCHANT_ORIGIN, path, 'GET'),
        makeRes(),
        localNext as unknown as NextFunction
      );
      return localNext.mock.calls.length > 0;
    });
    expect(verdicts).toEqual([false, false, false, true]);
  });

  /**
   * The gate that makes the allow-list maintainable instead of another stale
   * enumeration: re-derive the storefront's /stores calls from apps/web and
   * assert the middleware permits each one. Add a storefront call to a new
   * /stores path without listing it and this fails, naming the path — rather
   * than the feature 403-ing for every merchant on a custom domain while
   * working fine on the platform origin where it gets tested.
   */
  it('permits every /stores path apps/web actually calls (re-derived, not remembered)', () => {
    const webSrc = path.resolve(__dirname, '../../apps/web/src');
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) walk(full);
        // Skip test files: they contain path FRAGMENTS in assertions, not calls.
        else if (/\.(ts|tsx)$/.test(e.name) && !/\.test\.|__tests__/.test(full)) files.push(full);
      }
    };
    walk(webSrc);

    const found = new Map<string, string>();
    for (const f of files) {
      for (const line of readFileSync(f, 'utf8').split('\n')) {
        if (line.includes('/public/stores/')) continue; // different prefix, not this gate
        // A path written in a COMMENT is documentation, not a call. Several
        // modules document their own endpoint shape above the function that
        // builds it, and counting those produced a truncated `/stores/public`
        // that matches no route.
        const t = line.trim();
        if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) continue;
        // NOT `/stores/${` — that regex was the bug. Several routers mounted
        // at the bare /stores prefix declare their storefront endpoints as
        // `/public/:storeId/...`, so the live paths are
        // `/stores/public/${id}/shipping` and friends, with a LITERAL segment
        // where the old pattern demanded an interpolation. It matched zero of
        // them, so the gate could deny all of checkout and this test stayed
        // green. Match any segment, literal or interpolated.
        for (const m of line.matchAll(/\/stores\/[A-Za-z0-9_$.{}-]+[A-Za-z0-9/_.$?{}-]*/g)) {
          // Normalise every interpolation to a literal segment, and drop any
          // trailing query string — the gate matches on path only.
          // R2 asset URLs share this shape (`/stores/<uuid>/logos/x.png`) but
          // are object-storage paths, not API routes — this gate never sees
          // them. Anything ending in a file extension is one.
          if (/\.[a-z0-9]{2,4}$/i.test(m[0])) continue;
          const norm = m[0]
            .replace(/(?<!\/)\$\{[^}]*\}.*$/, '')
            .replace(/\$\{[^}]*\}/g, 'x')
            .split('?')[0]
            .replace(/\/$/, '');
          found.set(norm, path.relative(webSrc, f));
        }
      }
    }
    expect(
      found.size,
      'enumeration found no storefront calls — the regex has rotted'
    ).toBeGreaterThan(0);

    const denied: string[] = [];
    for (const [p, src] of found) {
      const localNext = vi.fn();
      restrictPlatformOnlyOrigins(
        makeReq(MERCHANT_ORIGIN, `/api/v1${p}`, 'POST'),
        makeRes(),
        localNext as unknown as NextFunction
      );
      if (localNext.mock.calls.length === 0) denied.push(`${p}  (${src})`);
    }
    // A path appearing in a source file is NOT evidence the storefront calls
    // it. apps/web/src/lib/api.ts defines getStoreProducts and getStoreProduct
    // — both labelled "for admin", both with zero callers — and allow-listing
    // them from this enumeration put two admin endpoints back through the
    // gate, including product reads carrying costPrice and draft rows. Dead
    // helpers are acknowledged here by name rather than silently permitted, so
    // adding one is a deliberate edit with a reason attached.
    const KNOWN_NON_STOREFRONT: Array<[RegExp, string]> = [
      [
        /^\/stores\/x\/products(\/x)?$/,
        'lib/api.ts getStoreProducts/getStoreProduct — admin-only, zero callers',
      ],
      [/^\/stores\/x$/, 'lib/store-resolver.ts getStoreById — server-side, sends no Origin'],
      [
        /^\/stores\/x\/blog\/x$/,
        'BlogPostBody.tsx fetchPost is a server-side fetch (no credentials, no Origin) and the route it named is the ADMIN single-post read; it now calls /public/:storeId/blog/:slug',
      ],
    ];
    const unexpected = denied.filter(
      d => !KNOWN_NON_STOREFRONT.some(([re]) => re.test(d.split('  ')[0]))
    );
    expect(
      unexpected,
      'these storefront calls are BLOCKED by the origin gate and would 403 on every merchant custom domain — add them to STOREFRONT_ALLOWED_STORE_PATHS, move them under /stores/public/, or list them in KNOWN_NON_STOREFRONT with a reason'
    ).toEqual([]);
  });
});

/**
 * The allow-list is read from the RAW path as well as the normalized one.
 *
 * `normalizePlatformGatePath` percent-decodes, and its own doc argued that was
 * safe because decoding "can only ever make MORE paths match the deny list".
 * That argument died when an allow-list started reading the same string:
 * there, decoding makes more paths match a PERMISSION. These cases are the
 * negative control for that — every one of them decodes into a shape the
 * storefront allow-list accepts, and every one must still be refused.
 */
describe('restrictPlatformOnlyOrigins — an encoded path cannot buy a permission', () => {
  it.each([
    ['/api/v1/stores/%70ublic/store-1/shipping', 'percent-encoded p in `public`'],
    ['/api/v1/stores/%2570ublic/store-1/shipping', 'double-encoded p in `public`'],
    ['/api/v1/stores/pub%6cic/store-1/coupons', 'percent-encoded l in `public`'],
    ['/api/v1/stores/public/%2e%2e/store-1/customers', 'encoded .. traversal out of /public/'],
    ['/api/v1/stores/public/../store-1/customers', 'literal .. traversal out of /public/'],
    ['/api/v1/stores/store-1/%72eviews', 'percent-encoded r in `reviews`'],
  ])('denies %s (%s)', path => {
    const req = makeReq(MERCHANT_ORIGIN, path);
    const res = makeRes();
    const next = vi.fn();

    restrictPlatformOnlyOrigins(req, res, next);

    expect(
      next,
      `${path} was ALLOWED — decoding must never grant a permission`
    ).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
    expect(res.body?.error?.code).toBe('ORIGIN_NOT_PERMITTED');
  });

  it('denies the ADMIN blog read a storefront caller never made', () => {
    // `/stores/:storeId/blog/:postId` is authenticate + authorize(store_admin,
    // super_admin, staff) + requireStoreAccess — the single-post read that
    // returns DRAFTS. It sat in the allow-list on the strength of
    // BlogPostBody.tsx, a server-side fetch that sends no Origin and so never
    // reaches this gate; it was also calling the wrong endpoint and getting a
    // 401. Allowing it bought a merchant origin a credentialed cross-origin
    // read of another tenant's unpublished posts.
    const req = makeReq(MERCHANT_ORIGIN, '/api/v1/stores/store-1/blog/post-1');
    const res = makeRes();
    const next = vi.fn();

    restrictPlatformOnlyOrigins(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
  });

  it('still allows the unencoded storefront call the encoded ones imitate', () => {
    // The positive control. Without it a gate that denied everything would
    // pass every case above while being useless.
    const req = makeReq(MERCHANT_ORIGIN, '/api/v1/stores/public/store-1/shipping');
    const res = makeRes();
    const next = vi.fn();

    restrictPlatformOnlyOrigins(req, res, next);

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
