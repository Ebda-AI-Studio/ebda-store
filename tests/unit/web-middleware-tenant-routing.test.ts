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
const ORIGINAL_ROUTES_ENV = process.env.STOREFRONT_TENANT_ROUTING_ROUTES;
const ORIGINAL_STORES_ENV = process.env.STOREFRONT_TENANT_ROUTING_STORES;

afterEach(() => {
  if (ORIGINAL_ENV === undefined) {
    delete process.env.STOREFRONT_TENANT_ROUTING;
  } else {
    process.env.STOREFRONT_TENANT_ROUTING = ORIGINAL_ENV;
  }
  if (ORIGINAL_ROUTES_ENV === undefined) {
    delete process.env.STOREFRONT_TENANT_ROUTING_ROUTES;
  } else {
    process.env.STOREFRONT_TENANT_ROUTING_ROUTES = ORIGINAL_ROUTES_ENV;
  }
  if (ORIGINAL_STORES_ENV === undefined) {
    delete process.env.STOREFRONT_TENANT_ROUTING_STORES;
  } else {
    process.env.STOREFRONT_TENANT_ROUTING_STORES = ORIGINAL_STORES_ENV;
  }
});

beforeEach(() => {
  delete process.env.STOREFRONT_TENANT_ROUTING;
  delete process.env.STOREFRONT_TENANT_ROUTING_ROUTES;
  delete process.env.STOREFRONT_TENANT_ROUTING_STORES;
});

/** Stores the Phase-1 fixtures below use: the platform slug and both custom
 *  domains. A missing store list routes nothing (TRC-6), so every test that
 *  expects a rewrite names its store. */
const FIXTURE_STORES = 'palora,wadyaljuz.com,pecannbee.com.kw';

/** Main flag on with the explicit full-rollout route list (`all`) and the
 *  fixture stores. A missing route or store list routes nothing (#1980,
 *  TRC-6), so the Phase-1 contract below needs all three. */
function enableAllTrackARoutes() {
  process.env.STOREFRONT_TENANT_ROUTING = 'true';
  process.env.STOREFRONT_TENANT_ROUTING_ROUTES = 'all';
  process.env.STOREFRONT_TENANT_ROUTING_STORES = FIXTURE_STORES;
}

function customDomainRequest(pathname: string, init?: { cookie?: string }) {
  return new NextRequest(`https://wadyaljuz.com${pathname}`, {
    headers: {
      host: 'wadyaljuz.com',
      ...(init?.cookie ? { cookie: init.cookie } : {}),
    },
  });
}

function platformSlugRequest(pathname: string, init?: { cookie?: string }) {
  return new NextRequest(`https://ebda.app${pathname}`, {
    headers: {
      host: 'ebda.app',
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
    enableAllTrackARoutes();
    const res = middleware(customDomainRequest('/'));
    const rewriteTarget = res.headers.get('x-middleware-rewrite');
    expect(rewriteTarget).toContain('/tenant-store/wadyaljuz.com/en');
  });

  it('flag on: custom-domain Track-A route (products) IS rewritten, locale from cookie', () => {
    enableAllTrackARoutes();
    const res = middleware(customDomainRequest('/products', { cookie: 'force-language=ar' }));
    const rewriteTarget = res.headers.get('x-middleware-rewrite');
    expect(rewriteTarget).toContain('/tenant-store/wadyaljuz.com/ar/products');
  });

  it('flag on: Track-B route (cart) is NEVER rewritten to tenant-store', () => {
    enableAllTrackARoutes();
    const res = middleware(customDomainRequest('/cart'));
    const rewriteTarget = res.headers.get('x-middleware-rewrite') ?? '';
    expect(rewriteTarget).not.toContain('/tenant-store/');
  });

  it('flag on: admin preview iframe (?_preview=) bypasses the rewrite entirely', () => {
    enableAllTrackARoutes();
    const res = middleware(customDomainRequest('/products?_preview=123'));
    const rewriteTarget = res.headers.get('x-middleware-rewrite') ?? '';
    expect(rewriteTarget).not.toContain('/tenant-store/');
  });

  it('flag on: platform-slug Track-A route IS rewritten to /tenant-store/slug:<slug>/en', () => {
    enableAllTrackARoutes();
    const res = middleware(platformSlugRequest('/palora/products'));
    const rewriteTarget = res.headers.get('x-middleware-rewrite');
    expect(rewriteTarget).toContain(
      `/tenant-store/${encodeURIComponent('slug:palora')}/en/products`
    );
  });

  it('flag on: platform subroute via the x-store-slug cookie fallback IS rewritten', () => {
    enableAllTrackARoutes();
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
    enableAllTrackARoutes();
    const res = middleware(
      platformSlugRequest(`/tenant-store/${encodeURIComponent('slug:palora')}/en`)
    );
    expect(res.status).toBe(404);
  });
});

/**
 * Route-scoped canary: `STOREFRONT_TENANT_ROUTING_ROUTES` (plan §9 Phase 3 —
 * `/about` + `/faq` first). Contract:
 * - main flag off → the list changes NOTHING (byte-identical responses);
 * - main flag on + list set → only the listed Track-A roots rewrite;
 * - main flag on + list missing, empty or unparseable → NO route rewrites
 *   (fail-closed, #1980); `all` is the explicit full rollout.
 */
describe('middleware — STOREFRONT_TENANT_ROUTING_ROUTES canary list', () => {
  const ORIGINAL_ROUTES = process.env.STOREFRONT_TENANT_ROUTING_ROUTES;

  beforeEach(() => {
    delete process.env.STOREFRONT_TENANT_ROUTING_ROUTES;
    // This block tests the ROUTE list; the store gate is satisfied here and
    // exercised on its own in the STORES block below.
    process.env.STOREFRONT_TENANT_ROUTING_STORES = FIXTURE_STORES;
  });

  afterEach(() => {
    if (ORIGINAL_ROUTES === undefined) delete process.env.STOREFRONT_TENANT_ROUTING_ROUTES;
    else process.env.STOREFRONT_TENANT_ROUTING_ROUTES = ORIGINAL_ROUTES;
  });

  const rewriteOf = (res: Response) => res.headers.get('x-middleware-rewrite') ?? '';

  /** Every observable part of a middleware response, for byte-for-byte comparison. */
  const snapshot = (res: Response) => ({
    status: res.status,
    headers: [...res.headers.entries()].sort(([a], [b]) => a.localeCompare(b)),
  });

  const SAMPLE_REQUESTS = () => [
    customDomainRequest('/'),
    customDomainRequest('/about'),
    customDomainRequest('/faq', { cookie: 'force-language=ar' }),
    customDomainRequest('/products/some-product'),
    customDomainRequest('/cart'),
    customDomainRequest('/about?_preview=1'),
    platformSlugRequest('/palora'),
    platformSlugRequest('/palora/about'),
    platformSlugRequest('/faq', { cookie: 'x-store-slug=palora' }),
    platformSlugRequest('/'),
  ];

  it('main flag off: setting the list is byte-identical to not setting it', () => {
    const baseline = SAMPLE_REQUESTS().map(r => snapshot(middleware(r)));
    process.env.STOREFRONT_TENANT_ROUTING_ROUTES = 'about,faq,home,products';
    const withList = SAMPLE_REQUESTS().map(r => snapshot(middleware(r)));
    expect(withList).toEqual(baseline);
    for (const s of withList) {
      const rewrite = s.headers.find(([k]) => k === 'x-middleware-rewrite')?.[1] ?? '';
      expect(rewrite).not.toContain('/tenant-store/');
    }
  });

  const TRACK_A_PATHS = ['/', '/about', '/faq', '/products', '/products/x', '/blog/y', '/terms'];

  /** No request at all reaches the tenant tree: custom domain, path slug and cookie slug. */
  const expectNoRouteRewrites = () => {
    for (const path of TRACK_A_PATHS) {
      expect(rewriteOf(middleware(customDomainRequest(path)))).not.toContain('/tenant-store/');
      expect(rewriteOf(middleware(platformSlugRequest(`/palora${path}`)))).not.toContain(
        '/tenant-store/'
      );
      expect(
        rewriteOf(middleware(platformSlugRequest(path, { cookie: 'x-store-slug=palora' })))
      ).not.toContain('/tenant-store/');
    }
  };

  it('main flag on + list MISSING: no route rewrites (fail-closed, #1980)', () => {
    process.env.STOREFRONT_TENANT_ROUTING = 'true';
    expect(process.env.STOREFRONT_TENANT_ROUTING_ROUTES).toBeUndefined();
    expectNoRouteRewrites();
  });

  it('main flag on + list EMPTY: no route rewrites (fail-closed, #1980)', () => {
    process.env.STOREFRONT_TENANT_ROUTING = 'true';
    for (const value of ['', '   ', ',', ' , ,']) {
      process.env.STOREFRONT_TENANT_ROUTING_ROUTES = value;
      expectNoRouteRewrites();
    }
  });

  it('main flag on + list UNPARSEABLE: no route rewrites, even for valid tokens in it (#1980)', () => {
    process.env.STOREFRONT_TENANT_ROUTING = 'true';
    for (const value of [
      'abuot',
      'about,fqa',
      'about;faq',
      'about faq',
      'all,about',
      '*',
      'true',
      '["about","faq"]',
    ]) {
      process.env.STOREFRONT_TENANT_ROUTING_ROUTES = value;
      expectNoRouteRewrites();
    }
  });

  it('main flag on + list "all": every Track-A root rewrites (the explicit full rollout)', () => {
    process.env.STOREFRONT_TENANT_ROUTING = 'true';
    process.env.STOREFRONT_TENANT_ROUTING_ROUTES = ' ALL ';
    for (const path of TRACK_A_PATHS) {
      expect(rewriteOf(middleware(customDomainRequest(path)))).toContain(
        '/tenant-store/wadyaljuz.com/en'
      );
    }
    expect(rewriteOf(middleware(customDomainRequest('/cart')))).not.toContain('/tenant-store/');
  });

  it('main flag on + a valid list rewrites exactly its routes (positive control)', () => {
    process.env.STOREFRONT_TENANT_ROUTING = 'true';
    process.env.STOREFRONT_TENANT_ROUTING_ROUTES = 'home,about,faq,products,blog,terms';
    for (const path of TRACK_A_PATHS) {
      expect(rewriteOf(middleware(customDomainRequest(path)))).toContain(
        '/tenant-store/wadyaljuz.com/en'
      );
    }
  });

  it('main flag on + list "about,faq": only /about and /faq rewrite, on custom domains', () => {
    process.env.STOREFRONT_TENANT_ROUTING = 'true';
    process.env.STOREFRONT_TENANT_ROUTING_ROUTES = 'about,faq';
    expect(rewriteOf(middleware(customDomainRequest('/about')))).toContain(
      '/tenant-store/wadyaljuz.com/en/about'
    );
    expect(
      rewriteOf(middleware(customDomainRequest('/faq', { cookie: 'force-language=ar' })))
    ).toContain('/tenant-store/wadyaljuz.com/ar/faq');
    for (const path of ['/', '/products', '/products/x', '/categories', '/blog', '/terms']) {
      expect(rewriteOf(middleware(customDomainRequest(path)))).not.toContain('/tenant-store/');
    }
  });

  it('main flag on + list "about,faq": platform slug + cookie paths honour the list too', () => {
    process.env.STOREFRONT_TENANT_ROUTING = 'true';
    process.env.STOREFRONT_TENANT_ROUTING_ROUTES = 'about,faq';
    const slugKey = encodeURIComponent('slug:palora');
    expect(rewriteOf(middleware(platformSlugRequest('/palora/about')))).toContain(
      `/tenant-store/${slugKey}/en/about`
    );
    expect(
      rewriteOf(middleware(platformSlugRequest('/faq', { cookie: 'x-store-slug=palora' })))
    ).toContain(`/tenant-store/${slugKey}/en/faq`);
    // Home + PLP on the platform host keep today's slug-stripping rewrite.
    const home = rewriteOf(middleware(platformSlugRequest('/palora')));
    expect(home).not.toContain('/tenant-store/');
    const plp = rewriteOf(middleware(platformSlugRequest('/palora/products')));
    expect(plp).not.toContain('/tenant-store/');
    expect(new URL(plp).pathname).toBe('/products');
  });

  it('list "home" enables only the bare root', () => {
    process.env.STOREFRONT_TENANT_ROUTING = 'true';
    process.env.STOREFRONT_TENANT_ROUTING_ROUTES = ' Home ';
    expect(rewriteOf(middleware(customDomainRequest('/')))).toContain(
      '/tenant-store/wadyaljuz.com/en'
    );
    expect(rewriteOf(middleware(customDomainRequest('/about')))).not.toContain('/tenant-store/');
  });

  it('the list can never widen past Track A: listing cart/checkout rewrites nothing', () => {
    process.env.STOREFRONT_TENANT_ROUTING = 'true';
    process.env.STOREFRONT_TENANT_ROUTING_ROUTES = 'cart,checkout,account';
    for (const path of ['/cart', '/checkout', '/account', '/about']) {
      expect(rewriteOf(middleware(customDomainRequest(path)))).not.toContain('/tenant-store/');
    }
  });

  it('the preview iframe still bypasses a listed route', () => {
    process.env.STOREFRONT_TENANT_ROUTING = 'true';
    process.env.STOREFRONT_TENANT_ROUTING_ROUTES = 'about';
    expect(rewriteOf(middleware(customDomainRequest('/about?_preview=1')))).not.toContain(
      '/tenant-store/'
    );
  });
});

/**
 * Ruling TRC-6: `STOREFRONT_TENANT_ROUTING_STORES` is the per-store scope. The
 * rewrite needs the main flag AND a listed route AND a listed store. One Worker
 * serves palora (platform slug), pecannbee.com.kw and wadyaljuz.com (custom
 * domains), so these tests drive all three through one allowlist.
 */
describe('middleware — STOREFRONT_TENANT_ROUTING_STORES allowlist (TRC-6)', () => {
  const rewriteOf = (res: Response) => res.headers.get('x-middleware-rewrite') ?? '';
  const PALORA_KEY = encodeURIComponent('slug:palora');

  const pecannbeeRequest = (pathname: string) =>
    new NextRequest(`https://pecannbee.com.kw${pathname}`, {
      headers: { host: 'pecannbee.com.kw' },
    });
  const wwwPecannbeeRequest = (pathname: string) =>
    new NextRequest(`https://www.pecannbee.com.kw${pathname}`, {
      headers: { host: 'www.pecannbee.com.kw' },
    });

  const paloraRewrites = () =>
    rewriteOf(middleware(platformSlugRequest('/palora/about'))).includes(
      `/tenant-store/${PALORA_KEY}/`
    );
  const pecannbeeRewrites = () =>
    rewriteOf(middleware(pecannbeeRequest('/about'))).includes('/tenant-store/');
  const wadyaljuzRewrites = () =>
    rewriteOf(middleware(customDomainRequest('/about'))).includes('/tenant-store/');
  const paloraCookieRewrites = () =>
    rewriteOf(middleware(platformSlugRequest('/faq', { cookie: 'x-store-slug=palora' }))).includes(
      '/tenant-store/'
    );

  beforeEach(() => {
    process.env.STOREFRONT_TENANT_ROUTING = 'true';
    process.env.STOREFRONT_TENANT_ROUTING_ROUTES = 'about,faq';
  });

  const expectNoStoreRewrites = () => {
    expect(paloraRewrites()).toBe(false);
    expect(paloraCookieRewrites()).toBe(false);
    expect(pecannbeeRewrites()).toBe(false);
    expect(wadyaljuzRewrites()).toBe(false);
  };

  it('store list MISSING: no store rewrites (fail-closed)', () => {
    expect(process.env.STOREFRONT_TENANT_ROUTING_STORES).toBeUndefined();
    expectNoStoreRewrites();
  });

  it('store list EMPTY: no store rewrites (fail-closed)', () => {
    for (const value of ['', '   ', ',', ' , ,']) {
      process.env.STOREFRONT_TENANT_ROUTING_STORES = value;
      expectNoStoreRewrites();
    }
  });

  it('store list GARBAGE: no store rewrites, even for a valid token inside it (fail-closed)', () => {
    for (const value of [
      'palora,,,%%%',
      'palora;pecannbee',
      'palora pecannbee',
      'palora,*',
      '*',
      'all',
      'palora,all',
      'ALL',
      'slug:palora',
      '["palora"]',
      'palora/',
      '.palora',
      '-palora',
      'palora.',
    ]) {
      process.env.STOREFRONT_TENANT_ROUTING_STORES = value;
      expectNoStoreRewrites();
    }
  });

  it('store list "palora": palora rewrites on the path and cookie paths (positive control)', () => {
    process.env.STOREFRONT_TENANT_ROUTING_STORES = 'palora';
    expect(rewriteOf(middleware(platformSlugRequest('/palora/about')))).toContain(
      `/tenant-store/${PALORA_KEY}/en/about`
    );
    expect(paloraCookieRewrites()).toBe(true);
  });

  it('store list "palora": pecannbee.com.kw and wadyaljuz.com do NOT rewrite', () => {
    process.env.STOREFRONT_TENANT_ROUTING_STORES = 'palora';
    expect(pecannbeeRewrites()).toBe(false);
    expect(wadyaljuzRewrites()).toBe(false);
    expect(rewriteOf(middleware(wwwPecannbeeRequest('/about')))).not.toContain('/tenant-store/');
  });

  it('store list "palora": other platform slugs do NOT rewrite', () => {
    process.env.STOREFRONT_TENANT_ROUTING_STORES = 'palora';
    expect(rewriteOf(middleware(platformSlugRequest('/someoneelse/about')))).not.toContain(
      '/tenant-store/'
    );
    expect(
      rewriteOf(middleware(platformSlugRequest('/faq', { cookie: 'x-store-slug=someoneelse' })))
    ).not.toContain('/tenant-store/');
  });

  it('a custom domain is allowlisted by its hostname, case normalized', () => {
    process.env.STOREFRONT_TENANT_ROUTING_STORES = 'PecannBee.com.kw';
    expect(rewriteOf(middleware(pecannbeeRequest('/about')))).toContain(
      '/tenant-store/pecannbee.com.kw/en/about'
    );
    // www never reaches the rewrite: it 301s to the apex, which then matches.
    expect(middleware(wwwPecannbeeRequest('/about')).status).toBe(301);
    expect(paloraRewrites()).toBe(false);
    expect(wadyaljuzRewrites()).toBe(false);
  });

  it('a bare slug token never matches a custom domain whose host merely contains it', () => {
    process.env.STOREFRONT_TENANT_ROUTING_STORES = 'pecannbee';
    expect(pecannbeeRewrites()).toBe(false);
  });

  it('the store list cannot widen the route list: an unlisted route stays unrewritten', () => {
    process.env.STOREFRONT_TENANT_ROUTING_STORES = 'palora';
    expect(rewriteOf(middleware(platformSlugRequest('/palora/products')))).not.toContain(
      '/tenant-store/'
    );
  });

  it('main flag off: a listed store still rewrites nothing', () => {
    process.env.STOREFRONT_TENANT_ROUTING_STORES = 'palora';
    delete process.env.STOREFRONT_TENANT_ROUTING;
    expectNoStoreRewrites();
  });

  it('the preview iframe still bypasses a listed store', () => {
    process.env.STOREFRONT_TENANT_ROUTING_STORES = 'palora';
    expect(rewriteOf(middleware(platformSlugRequest('/palora/about?_preview=1')))).not.toContain(
      '/tenant-store/'
    );
  });
});

/**
 * Issue 2419 / Ruling TRC-7. The rewrite bakes the locale into the route (and
 * so into the cache key). It used to be cookie -> `en`, so a cookie-less visitor
 * to an Arabic-default store shared the English key. A store token may now
 * declare its default language (`palora:ar`), and the cookie still wins.
 */
describe('middleware — store default locale in the route key (issue 2419)', () => {
  const localeOf = (res: Response) => {
    const rewrite = res.headers.get('x-middleware-rewrite') ?? '';
    return new URL(rewrite).pathname.split('/')[3];
  };

  beforeEach(() => {
    process.env.STOREFRONT_TENANT_ROUTING = 'true';
    process.env.STOREFRONT_TENANT_ROUTING_ROUTES = 'about,faq';
  });

  it('AR-default store, no cookie: the route carries ar (platform path)', () => {
    process.env.STOREFRONT_TENANT_ROUTING_STORES = 'palora:ar';
    expect(localeOf(middleware(platformSlugRequest('/palora/about')))).toBe('ar');
  });

  it('AR-default store, no cookie: the route carries ar (custom domain)', () => {
    process.env.STOREFRONT_TENANT_ROUTING_STORES = 'wadyaljuz.com:ar';
    expect(localeOf(middleware(customDomainRequest('/about')))).toBe('ar');
  });

  it('AR-default store, no cookie: the route carries ar (x-store-slug cookie path)', () => {
    process.env.STOREFRONT_TENANT_ROUTING_STORES = 'palora:ar';
    expect(
      localeOf(middleware(platformSlugRequest('/faq', { cookie: 'x-store-slug=palora' })))
    ).toBe('ar');
  });

  it('AR-default store, force-language=en: the cookie wins, the route carries en', () => {
    process.env.STOREFRONT_TENANT_ROUTING_STORES = 'wadyaljuz.com:ar';
    expect(
      localeOf(middleware(customDomainRequest('/about', { cookie: 'force-language=en' })))
    ).toBe('en');
  });

  it('AR-default store, force-language=ar: the route carries ar', () => {
    process.env.STOREFRONT_TENANT_ROUTING_STORES = 'wadyaljuz.com:ar';
    expect(
      localeOf(middleware(customDomainRequest('/about', { cookie: 'force-language=ar' })))
    ).toBe('ar');
  });

  it('EN-default store (bare token), no cookie: the route carries en', () => {
    process.env.STOREFRONT_TENANT_ROUTING_STORES = 'wadyaljuz.com';
    expect(localeOf(middleware(customDomainRequest('/about')))).toBe('en');
  });

  it('a junk language cookie falls back to the store default, like the root layout', () => {
    process.env.STOREFRONT_TENANT_ROUTING_STORES = 'wadyaljuz.com:ar';
    expect(
      localeOf(middleware(customDomainRequest('/about', { cookie: 'force-language=fr' })))
    ).toBe('ar');
  });

  it('the default belongs to ITS store: another listed store keeps en', () => {
    process.env.STOREFRONT_TENANT_ROUTING_STORES = 'palora:ar,wadyaljuz.com';
    expect(localeOf(middleware(customDomainRequest('/about')))).toBe('en');
    expect(localeOf(middleware(platformSlugRequest('/palora/about')))).toBe('ar');
  });

  it.each(['palora:fr', 'palora:ar:en', 'palora:', 'all:ar', 'palora:AR ,pecannbee.com.kw:xx'])(
    'a bad language suffix makes the WHOLE list unparseable: %s routes no store',
    raw => {
      process.env.STOREFRONT_TENANT_ROUTING_STORES = raw;
      expect(
        middleware(platformSlugRequest('/palora/about')).headers.get('x-middleware-rewrite')
      ).not.toContain('/tenant-store/');
    }
  );

  it('main flag off: a store declared :ar rewrites nothing (parity with no declaration)', () => {
    process.env.STOREFRONT_TENANT_ROUTING_STORES = 'palora:ar';
    delete process.env.STOREFRONT_TENANT_ROUTING;
    const res = middleware(platformSlugRequest('/palora/about'));
    expect(res.headers.get('x-middleware-rewrite') ?? '').not.toContain('/tenant-store/');
  });
});
