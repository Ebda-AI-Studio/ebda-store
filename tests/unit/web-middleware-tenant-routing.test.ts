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
const FIXTURE_STORES = 'demo-boutique,demo-shop.example,demo-store.example';

/** Main flag on with the explicit full-rollout route list (`all`) and the
 *  fixture stores. A missing route or store list routes nothing (#1980,
 *  TRC-6), so the Phase-1 contract below needs all three. */
function enableAllTrackARoutes() {
  process.env.STOREFRONT_TENANT_ROUTING = 'true';
  process.env.STOREFRONT_TENANT_ROUTING_ROUTES = 'all';
  process.env.STOREFRONT_TENANT_ROUTING_STORES = FIXTURE_STORES;
}

function customDomainRequest(pathname: string, init?: { cookie?: string }) {
  return new NextRequest(`https://demo-shop.example${pathname}`, {
    headers: {
      host: 'demo-shop.example',
      ...(init?.cookie ? { cookie: init.cookie } : {}),
    },
  });
}

/** A request to a store's free `<slug>.ebda.app` host (default slug: demo-boutique). */
function subdomainRequest(pathname: string, init?: { cookie?: string; slug?: string }) {
  const host = `${init?.slug ?? 'demo-boutique'}.ebda.app`;
  return new NextRequest(`https://${host}${pathname}`, {
    headers: {
      host,
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

  it('flag unset (default): <slug>.ebda.app Track-A route is NOT rewritten to tenant-store', () => {
    const res = middleware(subdomainRequest('/products'));
    expect(res.headers.get('x-middleware-rewrite')).toBeNull();
  });

  it('flag on: custom-domain Track-A route (home) IS rewritten to /tenant-store/<domain>/en', () => {
    enableAllTrackARoutes();
    const res = middleware(customDomainRequest('/'));
    const rewriteTarget = res.headers.get('x-middleware-rewrite');
    expect(rewriteTarget).toContain('/tenant-store/demo-shop.example/en');
  });

  it('flag on: custom-domain Track-A route (products) IS rewritten, locale from cookie', () => {
    enableAllTrackARoutes();
    const res = middleware(customDomainRequest('/products', { cookie: 'force-language=ar' }));
    const rewriteTarget = res.headers.get('x-middleware-rewrite');
    expect(rewriteTarget).toContain('/tenant-store/demo-shop.example/ar/products');
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

  it('flag on: <slug>.ebda.app Track-A route IS rewritten to /tenant-store/<slug>.ebda.app/en', () => {
    enableAllTrackARoutes();
    const res = middleware(subdomainRequest('/products'));
    const rewriteTarget = res.headers.get('x-middleware-rewrite');
    expect(rewriteTarget).toContain('/tenant-store/demo-boutique.ebda.app/en/products');
  });

  it('flag on: a legacy x-store-slug cookie on a store host changes nothing (the host wins)', () => {
    enableAllTrackARoutes();
    const res = middleware(subdomainRequest('/products', { cookie: 'x-store-slug=demo-store' }));
    expect(res.headers.get('x-middleware-rewrite')).toContain(
      '/tenant-store/demo-boutique.ebda.app/en/products'
    );
  });

  // /tenant-store/* is an internal rewrite target only. A direct external hit
  // would bypass the Host→tenant binding (any domain rendering any tenant), so
  // the middleware must 404 it regardless of flag state or host shape.
  it('direct external /tenant-store/ hit is 404, flag off, custom domain', () => {
    const res = middleware(customDomainRequest('/tenant-store/demo-store.example/en/products'));
    expect(res.status).toBe(404);
  });

  it('direct external /tenant-store/ hit is 404, flag on, platform host', () => {
    enableAllTrackARoutes();
    const res = middleware(subdomainRequest('/tenant-store/demo-boutique.ebda.app/en'));
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
    // The CSP nonce is fresh on every request (Ruling CSP-WEB-1): compare everything else.
    headers: [...res.headers.entries()]
      .map(([k, v]) => [k, v.replace(/nonce-[^']+/g, 'nonce-N')] as [string, string])
      .filter(([k]) => k !== 'x-middleware-request-x-nonce')
      .sort(([a], [b]) => a.localeCompare(b)),
  });

  const SAMPLE_REQUESTS = () => [
    customDomainRequest('/'),
    customDomainRequest('/about'),
    customDomainRequest('/faq', { cookie: 'force-language=ar' }),
    customDomainRequest('/products/some-product'),
    customDomainRequest('/cart'),
    customDomainRequest('/about?_preview=1'),
    subdomainRequest('/'),
    subdomainRequest('/about'),
    subdomainRequest('/faq'),
    new NextRequest('https://ebda.app/', { headers: { host: 'ebda.app' } }),
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

  /** No request at all reaches the tenant tree: custom domain and slug subdomain. */
  const expectNoRouteRewrites = () => {
    for (const path of TRACK_A_PATHS) {
      expect(rewriteOf(middleware(customDomainRequest(path)))).not.toContain('/tenant-store/');
      expect(rewriteOf(middleware(subdomainRequest(path)))).not.toContain('/tenant-store/');
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
        '/tenant-store/demo-shop.example/en'
      );
    }
    expect(rewriteOf(middleware(customDomainRequest('/cart')))).not.toContain('/tenant-store/');
  });

  it('main flag on + a valid list rewrites exactly its routes (positive control)', () => {
    process.env.STOREFRONT_TENANT_ROUTING = 'true';
    process.env.STOREFRONT_TENANT_ROUTING_ROUTES = 'home,about,faq,products,blog,terms';
    for (const path of TRACK_A_PATHS) {
      expect(rewriteOf(middleware(customDomainRequest(path)))).toContain(
        '/tenant-store/demo-shop.example/en'
      );
    }
  });

  it('main flag on + list "about,faq": only /about and /faq rewrite, on custom domains', () => {
    process.env.STOREFRONT_TENANT_ROUTING = 'true';
    process.env.STOREFRONT_TENANT_ROUTING_ROUTES = 'about,faq';
    expect(rewriteOf(middleware(customDomainRequest('/about')))).toContain(
      '/tenant-store/demo-shop.example/en/about'
    );
    expect(
      rewriteOf(middleware(customDomainRequest('/faq', { cookie: 'force-language=ar' })))
    ).toContain('/tenant-store/demo-shop.example/ar/faq');
    for (const path of ['/', '/products', '/products/x', '/categories', '/blog', '/terms']) {
      expect(rewriteOf(middleware(customDomainRequest(path)))).not.toContain('/tenant-store/');
    }
  });

  it('main flag on + list "about,faq": <slug>.ebda.app honours the list too', () => {
    process.env.STOREFRONT_TENANT_ROUTING = 'true';
    process.env.STOREFRONT_TENANT_ROUTING_ROUTES = 'about,faq';
    const slugKey = 'demo-boutique.ebda.app';
    expect(rewriteOf(middleware(subdomainRequest('/about')))).toContain(
      `/tenant-store/${slugKey}/en/about`
    );
    expect(rewriteOf(middleware(subdomainRequest('/faq')))).toContain(
      `/tenant-store/${slugKey}/en/faq`
    );
    // Home + PLP are not on the list, so they stay on the header-based path.
    const home = rewriteOf(middleware(subdomainRequest('/')));
    expect(home).not.toContain('/tenant-store/');
    const plp = rewriteOf(middleware(subdomainRequest('/products')));
    expect(plp).not.toContain('/tenant-store/');
  });

  it('list "home" enables only the bare root', () => {
    process.env.STOREFRONT_TENANT_ROUTING = 'true';
    process.env.STOREFRONT_TENANT_ROUTING_ROUTES = ' Home ';
    expect(rewriteOf(middleware(customDomainRequest('/')))).toContain(
      '/tenant-store/demo-shop.example/en'
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
 * serves demo-boutique (platform slug), demo-store.example and demo-shop.example (custom
 * domains), so these tests drive all three through one allowlist.
 */
describe('middleware — STOREFRONT_TENANT_ROUTING_STORES allowlist (TRC-6)', () => {
  const rewriteOf = (res: Response) => res.headers.get('x-middleware-rewrite') ?? '';
  const DEMO_BOUTIQUE_KEY = 'demo-boutique.ebda.app';

  const demoStoreRequest = (pathname: string) =>
    new NextRequest(`https://demo-store.example${pathname}`, {
      headers: { host: 'demo-store.example' },
    });
  const wwwDemoStoreRequest = (pathname: string) =>
    new NextRequest(`https://www.demo-store.example${pathname}`, {
      headers: { host: 'www.demo-store.example' },
    });

  const demoBoutiqueRewrites = () =>
    rewriteOf(middleware(subdomainRequest('/about'))).includes(
      `/tenant-store/${DEMO_BOUTIQUE_KEY}/`
    );
  const demoStoreRewrites = () =>
    rewriteOf(middleware(demoStoreRequest('/about'))).includes('/tenant-store/');
  const demoShopRewrites = () =>
    rewriteOf(middleware(customDomainRequest('/about'))).includes('/tenant-store/');
  const demoBoutiqueCookieRewrites = () =>
    rewriteOf(middleware(subdomainRequest('/faq'))).includes('/tenant-store/');

  beforeEach(() => {
    process.env.STOREFRONT_TENANT_ROUTING = 'true';
    process.env.STOREFRONT_TENANT_ROUTING_ROUTES = 'about,faq';
  });

  const expectNoStoreRewrites = () => {
    expect(demoBoutiqueRewrites()).toBe(false);
    expect(demoBoutiqueCookieRewrites()).toBe(false);
    expect(demoStoreRewrites()).toBe(false);
    expect(demoShopRewrites()).toBe(false);
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
      'demo-boutique,,,%%%',
      'demo-boutique;demo-store',
      'demo-boutique demo-store',
      'demo-boutique,*',
      '*',
      'all',
      'demo-boutique,all',
      'ALL',
      'slug:demo-boutique',
      '["demo-boutique"]',
      'demo-boutique/',
      '.demo-boutique',
      '-demo-boutique',
      'demo-boutique.',
    ]) {
      process.env.STOREFRONT_TENANT_ROUTING_STORES = value;
      expectNoStoreRewrites();
    }
  });

  it('store list "demo-boutique": demo-boutique rewrites on the path and cookie paths (positive control)', () => {
    process.env.STOREFRONT_TENANT_ROUTING_STORES = 'demo-boutique';
    expect(rewriteOf(middleware(subdomainRequest('/about')))).toContain(
      `/tenant-store/${DEMO_BOUTIQUE_KEY}/en/about`
    );
    expect(demoBoutiqueCookieRewrites()).toBe(true);
  });

  it('store list "demo-boutique": demo-store.example and demo-shop.example do NOT rewrite', () => {
    process.env.STOREFRONT_TENANT_ROUTING_STORES = 'demo-boutique';
    expect(demoStoreRewrites()).toBe(false);
    expect(demoShopRewrites()).toBe(false);
    expect(rewriteOf(middleware(wwwDemoStoreRequest('/about')))).not.toContain('/tenant-store/');
  });

  it('store list "demo-boutique": other platform slugs do NOT rewrite', () => {
    process.env.STOREFRONT_TENANT_ROUTING_STORES = 'demo-boutique';
    expect(
      rewriteOf(middleware(subdomainRequest('/about', { slug: 'someoneelse' })))
    ).not.toContain('/tenant-store/');
    expect(rewriteOf(middleware(subdomainRequest('/faq', { slug: 'someoneelse' })))).not.toContain(
      '/tenant-store/'
    );
  });

  it('a custom domain is allowlisted by its hostname, case normalized', () => {
    process.env.STOREFRONT_TENANT_ROUTING_STORES = 'Demo-Store.example';
    expect(rewriteOf(middleware(demoStoreRequest('/about')))).toContain(
      '/tenant-store/demo-store.example/en/about'
    );
    // www never reaches the rewrite: it 301s to the apex, which then matches.
    expect(middleware(wwwDemoStoreRequest('/about')).status).toBe(301);
    expect(demoBoutiqueRewrites()).toBe(false);
    expect(demoShopRewrites()).toBe(false);
  });

  it('a bare slug token never matches a custom domain whose host merely contains it', () => {
    process.env.STOREFRONT_TENANT_ROUTING_STORES = 'demo-store';
    expect(demoStoreRewrites()).toBe(false);
  });

  it('the store list cannot widen the route list: an unlisted route stays unrewritten', () => {
    process.env.STOREFRONT_TENANT_ROUTING_STORES = 'demo-boutique';
    expect(rewriteOf(middleware(subdomainRequest('/products')))).not.toContain('/tenant-store/');
  });

  it('main flag off: a listed store still rewrites nothing', () => {
    process.env.STOREFRONT_TENANT_ROUTING_STORES = 'demo-boutique';
    delete process.env.STOREFRONT_TENANT_ROUTING;
    expectNoStoreRewrites();
  });

  it('the preview iframe still bypasses a listed store', () => {
    process.env.STOREFRONT_TENANT_ROUTING_STORES = 'demo-boutique';
    expect(rewriteOf(middleware(subdomainRequest('/about?_preview=1')))).not.toContain(
      '/tenant-store/'
    );
  });
});

/**
 * Issue 2419 / Ruling TRC-7. The rewrite bakes the locale into the route (and
 * so into the cache key). It used to be cookie -> `en`, so a cookie-less visitor
 * to an Arabic-default store shared the English key. A store token may now
 * declare its default language (`demo-boutique:ar`), and the cookie still wins.
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
    process.env.STOREFRONT_TENANT_ROUTING_STORES = 'demo-boutique:ar';
    expect(localeOf(middleware(subdomainRequest('/about')))).toBe('ar');
  });

  it('AR-default store, no cookie: the route carries ar (custom domain)', () => {
    process.env.STOREFRONT_TENANT_ROUTING_STORES = 'demo-shop.example:ar';
    expect(localeOf(middleware(customDomainRequest('/about')))).toBe('ar');
  });

  it('AR-default store, no cookie: the route carries ar (x-store-slug cookie path)', () => {
    process.env.STOREFRONT_TENANT_ROUTING_STORES = 'demo-boutique:ar';
    expect(localeOf(middleware(subdomainRequest('/faq')))).toBe('ar');
  });

  it('AR-default store, force-language=en: the cookie wins, the route carries en', () => {
    process.env.STOREFRONT_TENANT_ROUTING_STORES = 'demo-shop.example:ar';
    expect(
      localeOf(middleware(customDomainRequest('/about', { cookie: 'force-language=en' })))
    ).toBe('en');
  });

  it('AR-default store, force-language=ar: the route carries ar', () => {
    process.env.STOREFRONT_TENANT_ROUTING_STORES = 'demo-shop.example:ar';
    expect(
      localeOf(middleware(customDomainRequest('/about', { cookie: 'force-language=ar' })))
    ).toBe('ar');
  });

  it('EN-default store (bare token), no cookie: the route carries en', () => {
    process.env.STOREFRONT_TENANT_ROUTING_STORES = 'demo-shop.example';
    expect(localeOf(middleware(customDomainRequest('/about')))).toBe('en');
  });

  it('a junk language cookie falls back to the store default, like the root layout', () => {
    process.env.STOREFRONT_TENANT_ROUTING_STORES = 'demo-shop.example:ar';
    expect(
      localeOf(middleware(customDomainRequest('/about', { cookie: 'force-language=fr' })))
    ).toBe('ar');
  });

  it('the default belongs to ITS store: another listed store keeps en', () => {
    process.env.STOREFRONT_TENANT_ROUTING_STORES = 'demo-boutique:ar,demo-shop.example';
    expect(localeOf(middleware(customDomainRequest('/about')))).toBe('en');
    expect(localeOf(middleware(subdomainRequest('/about')))).toBe('ar');
  });

  it.each([
    'demo-boutique:fr',
    'demo-boutique:ar:en',
    'demo-boutique:',
    'all:ar',
    'demo-boutique:AR ,demo-store.example:xx',
  ])('a bad language suffix makes the WHOLE list unparseable: %s routes no store', raw => {
    process.env.STOREFRONT_TENANT_ROUTING_STORES = raw;
    expect(
      middleware(subdomainRequest('/about')).headers.get('x-middleware-rewrite') ?? ''
    ).not.toContain('/tenant-store/');
  });

  it('main flag off: a store declared :ar rewrites nothing (parity with no declaration)', () => {
    process.env.STOREFRONT_TENANT_ROUTING_STORES = 'demo-boutique:ar';
    delete process.env.STOREFRONT_TENANT_ROUTING;
    const res = middleware(subdomainRequest('/about'));
    expect(res.headers.get('x-middleware-rewrite') ?? '').not.toContain('/tenant-store/');
  });
});
