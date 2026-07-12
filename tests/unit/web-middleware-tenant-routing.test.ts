import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import { middleware } from '../../apps/web/middleware';

/**
 * Unit tests for the dark-launched tenant-cacheable routing rewrite added
 * to `apps/web/middleware.ts` (tenant-cacheable routing Phase 1 — see
 * docs/plans/2026-07-12-tenant-cacheable-routing.md §3.3/§9). Covers the
 * dark-launch contract: with the flag unset, every existing request path
 * is untouched; with the flag on, only Track-A routes on non-preview
 * requests get rewritten to `/tenant-store/[tenant]/[locale]/...`.
 */

const ORIGINAL_ENV = process.env.STOREFRONT_TENANT_ROUTING;

afterEach(() => {
  if (ORIGINAL_ENV === undefined) {
    delete process.env.STOREFRONT_TENANT_ROUTING;
  } else {
    process.env.STOREFRONT_TENANT_ROUTING = ORIGINAL_ENV;
  }
});

beforeEach(() => {
  delete process.env.STOREFRONT_TENANT_ROUTING;
});

function customDomainRequest(pathname: string, init?: { cookie?: string }) {
  return new NextRequest(`https://wadyaljuz.com${pathname}`, {
    headers: {
      host: 'wadyaljuz.com',
      ...(init?.cookie ? { cookie: init.cookie } : {}),
    },
  });
}

function platformSlugRequest(pathname: string, init?: { cookie?: string }) {
  return new NextRequest(`https://store.force-ai.co${pathname}`, {
    headers: {
      host: 'store.force-ai.co',
      ...(init?.cookie ? { cookie: init.cookie } : {}),
    },
  });
}

describe('middleware — STOREFRONT_TENANT_ROUTING dark-launch gate', () => {
  it('flag unset (default): custom-domain Track-A route is NOT rewritten to tenant-store', () => {
    const res = middleware(customDomainRequest('/products'));
    // NextResponse.next() carries no rewrite — the destination header is
    // absent / matches the original request.
    expect(res.headers.get('x-middleware-rewrite')).toBeNull();
  });

  it('flag unset (default): platform-slug Track-A route is NOT rewritten to tenant-store', () => {
    const res = middleware(platformSlugRequest('/palora/products'));
    const rewriteTarget = res.headers.get('x-middleware-rewrite');
    // The existing slug-stripping rewrite still applies (unchanged
    // behavior), but it must never point at the new tree.
    if (rewriteTarget) {
      expect(rewriteTarget).not.toContain('/tenant-store/');
    }
  });

  it('flag on: custom-domain Track-A route (home) IS rewritten to /tenant-store/<domain>/en', () => {
    process.env.STOREFRONT_TENANT_ROUTING = 'true';
    const res = middleware(customDomainRequest('/'));
    const rewriteTarget = res.headers.get('x-middleware-rewrite');
    expect(rewriteTarget).toContain('/tenant-store/wadyaljuz.com/en');
  });

  it('flag on: custom-domain Track-A route (products) IS rewritten, locale from cookie', () => {
    process.env.STOREFRONT_TENANT_ROUTING = 'true';
    const res = middleware(customDomainRequest('/products', { cookie: 'force-language=ar' }));
    const rewriteTarget = res.headers.get('x-middleware-rewrite');
    expect(rewriteTarget).toContain('/tenant-store/wadyaljuz.com/ar/products');
  });

  it('flag on: Track-B route (cart) is NEVER rewritten to tenant-store', () => {
    process.env.STOREFRONT_TENANT_ROUTING = 'true';
    const res = middleware(customDomainRequest('/cart'));
    const rewriteTarget = res.headers.get('x-middleware-rewrite') ?? '';
    expect(rewriteTarget).not.toContain('/tenant-store/');
  });

  it('flag on: admin preview iframe (?_preview=) bypasses the rewrite entirely', () => {
    process.env.STOREFRONT_TENANT_ROUTING = 'true';
    const res = middleware(customDomainRequest('/products?_preview=123'));
    const rewriteTarget = res.headers.get('x-middleware-rewrite') ?? '';
    expect(rewriteTarget).not.toContain('/tenant-store/');
  });

  it('flag on: platform-slug Track-A route IS rewritten to /tenant-store/slug:<slug>/en', () => {
    process.env.STOREFRONT_TENANT_ROUTING = 'true';
    const res = middleware(platformSlugRequest('/palora/products'));
    const rewriteTarget = res.headers.get('x-middleware-rewrite');
    expect(rewriteTarget).toContain(
      `/tenant-store/${encodeURIComponent('slug:palora')}/en/products`
    );
  });

  it('flag on: platform subroute via the x-store-slug cookie fallback IS rewritten', () => {
    process.env.STOREFRONT_TENANT_ROUTING = 'true';
    const res = middleware(platformSlugRequest('/products', { cookie: 'x-store-slug=palora' }));
    const rewriteTarget = res.headers.get('x-middleware-rewrite');
    expect(rewriteTarget).toContain(
      `/tenant-store/${encodeURIComponent('slug:palora')}/en/products`
    );
  });

  // /tenant-store/* is an internal rewrite target only. A direct external hit
  // would bypass the Host→tenant binding (any domain rendering any tenant), so
  // the middleware must 404 it regardless of flag state or host shape.
  it('direct external /tenant-store/ hit is 404, flag off, custom domain', () => {
    const res = middleware(customDomainRequest('/tenant-store/pecannbee.com/en/products'));
    expect(res.status).toBe(404);
  });

  it('direct external /tenant-store/ hit is 404, flag on, platform host', () => {
    process.env.STOREFRONT_TENANT_ROUTING = 'true';
    const res = middleware(
      platformSlugRequest(`/tenant-store/${encodeURIComponent('slug:palora')}/en`)
    );
    expect(res.status).toBe(404);
  });
});
