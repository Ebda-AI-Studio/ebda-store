import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NextRequest } from 'next/server';
import { middleware, MIDDLEWARE_ASSERTED_HEADERS } from '../../apps/web/middleware';
import {
  decideLocalePath,
  isLocalePathRoute,
  localeAlternates,
  localePathsOn,
  localizeHref,
  localizeJsonLdUrls,
  parseLocalePathStores,
  pendingRedirect,
  prefixedPath,
  splitLocalePrefix,
  storeKeyForHost,
  LOCALE_PATH_ROOTS,
} from '../../apps/web/src/lib/locale-paths';
import { swapLocalePrefix } from '../../apps/web/src/contexts/LanguageContext';

/**
 * Language in the URL (Ruling LOCALE-PATHS-1, audit M-168): pure rules, the middleware wiring, the hreflang
 * builder and the language switcher. Dark by default: with the flag or the store list missing, nothing changes.
 */

describe('locale path rules (pure)', () => {
  it("parses store keys only, fail-closed; a language suffix is rejected (the default is the store's own setting)", () => {
    expect(parseLocalePathStores('demo-boutique, shop.example')).toEqual(
      new Set(['demo-boutique', 'shop.example'])
    );
    for (const bad of [
      undefined,
      '',
      ' , ',
      'all,demo-boutique',
      'a,all',
      'a:ar',
      'a:en',
      'slug:x',
      'Bad Name',
      '*',
    ])
      expect(parseLocalePathStores(bad), String(bad)).toBeNull();
  });

  it('a LONE `all` opts every store host in (Ruling LOCALE-PATHS-2); the flag still gates it', () => {
    expect(parseLocalePathStores(' ALL ')).toEqual(new Set(['all']));
    const env = { STOREFRONT_LOCALE_PATHS: 'true', STOREFRONT_LOCALE_PATHS_STORES: 'all' };
    expect(localePathsOn('any-store', env)).toBe(true);
    expect(localePathsOn('shop.example', env)).toBe(true);
    expect(localePathsOn('any-store', { ...env, STOREFRONT_LOCALE_PATHS: 'false' })).toBe(false);
    expect(localePathsOn('any-store', { ...env, STOREFRONT_LOCALE_PATHS_STORES: 'all,x' })).toBe(
      false
    );
  });

  it('is on only with the flag AND a named store', () => {
    const env = {
      STOREFRONT_LOCALE_PATHS: 'true',
      STOREFRONT_LOCALE_PATHS_STORES: 'demo-boutique',
    };
    expect(localePathsOn('demo-boutique', env)).toBe(true);
    expect(localePathsOn('other', env)).toBe(false);
    expect(localePathsOn('demo-boutique', { ...env, STOREFRONT_LOCALE_PATHS: 'yes' })).toBe(false);
    expect(localePathsOn('demo-boutique', { STOREFRONT_LOCALE_PATHS: 'true' })).toBe(false);
  });

  it('splits a prefix only at a whole segment', () => {
    expect(splitLocalePrefix('/ar')).toEqual({ locale: 'ar', rest: '/' });
    expect(splitLocalePrefix('/en/')).toEqual({ locale: 'en', rest: '/' });
    expect(splitLocalePrefix('/en/products/x')).toEqual({ locale: 'en', rest: '/products/x' });
    for (const p of ['/', '/products', '/arabic', '/ar-eg/x', '/fr/products', '/cart'])
      expect(splitLocalePrefix(p)).toBeNull();
  });

  it('only the indexable roots carry a prefix', () => {
    for (const r of LOCALE_PATH_ROOTS) expect(isLocalePathRoute(`/${r}`)).toBe(true);
    expect(isLocalePathRoute('/')).toBe(true);
    expect(isLocalePathRoute('/products/a-b')).toBe(true);
    for (const r of [
      '/cart',
      '/checkout',
      '/account/orders',
      '/auth/login',
      '/search',
      '/wishlist',
      '/api/x',
      '/llms.txt',
      '/sitemap.xml',
      '/robots.txt',
    ])
      expect(isLocalePathRoute(r), r).toBe(false);
  });

  it('keeps the root list equal to the middleware Track-A list', () => {
    // the Track-A allowlist in middleware.ts is the same set of roots
    expect([...LOCALE_PATH_ROOTS].sort()).toEqual([
      'about',
      'blog',
      'categories',
      'contact',
      'faq',
      'how-to-guides',
      'locations',
      'privacy',
      'products',
      'returns',
      'shipping',
      'terms',
    ]);
  });

  const base = { search: '', method: 'GET' };
  it('the store-less middleware marks an old URL pending; it never picks a language', () => {
    expect(decideLocalePath({ ...base, pathname: '/products', search: '?sort=price' })).toEqual({
      kind: 'pending',
      rest: '/products',
    });
    expect(decideLocalePath({ ...base, pathname: '/' })).toEqual({ kind: 'pending', rest: '/' });
  });
  it('a prefixed route rewrites; a prefixed non-route redirects to the plain URL; the rest is untouched', () => {
    expect(decideLocalePath({ ...base, pathname: '/en/products/x' })).toEqual({
      kind: 'rewrite',
      locale: 'en',
      rest: '/products/x',
    });
    expect(decideLocalePath({ ...base, pathname: '/ar' })).toEqual({
      kind: 'rewrite',
      locale: 'ar',
      rest: '/',
    });
    expect(decideLocalePath({ ...base, pathname: '/ar/cart', search: '?a=1' })).toEqual({
      kind: 'redirect',
      location: '/cart?a=1',
    });
    expect(decideLocalePath({ ...base, pathname: '/cart' })).toEqual({ kind: 'none' });
    expect(decideLocalePath({ ...base, pathname: '/products', method: 'POST' })).toEqual({
      kind: 'none',
    });
  });
  it('the layout redirect: the store default is permanent, a cookie for the other language is temporary', () => {
    const r = { rest: '/products', search: '?sort=price', defaultLocale: 'ar' as const };
    expect(pendingRedirect(r)).toEqual({ location: '/ar/products?sort=price', permanent: true });
    expect(pendingRedirect({ ...r, cookieLocale: 'ar' })).toEqual({
      location: '/ar/products?sort=price',
      permanent: true,
    });
    expect(pendingRedirect({ ...r, cookieLocale: 'en' })).toEqual({
      location: '/en/products?sort=price',
      permanent: false,
    });
    expect(pendingRedirect({ ...r, cookieLocale: 'zz' }).permanent).toBe(true);
    expect(pendingRedirect({ rest: '/', search: '', defaultLocale: 'en' })).toEqual({
      location: '/en',
      permanent: true,
    });
  });
  it('localizes an href only on a prefixed page and only for indexable routes', () => {
    expect(localizeHref('/products', 'ar')).toBe('/ar/products');
    expect(localizeHref('/products/x?a=1#top', 'en')).toBe('/en/products/x?a=1#top');
    expect(localizeHref('/', 'ar')).toBe('/ar');
    expect(localizeHref('/?x=1', 'ar')).toBe('/ar?x=1');
    for (const keep of [
      '/cart',
      '/checkout',
      '/account/orders',
      '/auth/login',
      '/search?q=a',
      'https://x.com/products',
      '//cdn/x',
      'mailto:a@b.c',
      '#top',
      '?page=2',
      '/ar/products',
      '/en',
    ])
      expect(localizeHref(keep, 'ar'), keep).toBe(keep);
    expect(localizeHref('/products', null)).toBe('/products');
  });
  it('localizes the store URLs of a JSON-LD graph, nothing else', () => {
    const o = 'https://s.ebda.app';
    const g = {
      '@id': `${o}/products/x`,
      url: `${o}/products/x`,
      itemListElement: [{ item: o }, { item: `${o}/` }, { item: `${o}/categories` }],
      image: 'https://media.ebda.app/p.webp',
      cart: `${o}/cart`,
      sameAs: ['https://instagram.com/x'],
      name: 'Products',
    };
    const out = localizeJsonLdUrls(g, o, 'ar');
    expect(out['@id']).toBe(`${o}/ar/products/x`);
    expect(out.url).toBe(`${o}/ar/products/x`);
    expect(out.itemListElement.map(i => i.item)).toEqual([
      `${o}/ar`,
      `${o}/ar`,
      `${o}/ar/categories`,
    ]);
    expect(out.image).toBe(g.image);
    expect(out.cart).toBe(`${o}/cart`);
    expect(out.sameAs).toEqual(g.sameAs);
    expect(out.name).toBe('Products');
    expect(localizeJsonLdUrls(g, o, null)).toBe(g);
  });

  it('builds reciprocal hreflang with the default as x-default', () => {
    const a = localeAlternates({
      origin: 'https://s.ebda.app',
      path: '/products/x',
      locale: 'en',
      defaultLocale: 'ar',
    });
    expect(a).toEqual({
      canonical: 'https://s.ebda.app/en/products/x',
      languages: {
        ar: 'https://s.ebda.app/ar/products/x',
        en: 'https://s.ebda.app/en/products/x',
        'x-default': 'https://s.ebda.app/ar/products/x',
      },
    });
    // both languages name the same set, and each names itself
    const b = localeAlternates({
      origin: 'https://s.ebda.app',
      path: '/products/x',
      locale: 'ar',
      defaultLocale: 'ar',
    });
    expect(b.languages).toEqual(a.languages);
    expect(b.canonical).toBe(a.languages.ar);
    expect(
      localeAlternates({
        origin: 'https://s.ebda.app',
        path: '',
        locale: 'ar',
        defaultLocale: 'ar',
      }).canonical
    ).toBe('https://s.ebda.app/ar');
    expect(prefixedPath('en', '/')).toBe('/en');
  });

  it('keys a host the way the allowlist does', () => {
    expect(storeKeyForHost('Demo-Boutique.ebda.app')).toBe('demo-boutique');
    expect(storeKeyForHost('shop.example:443')).toBe('shop.example');
  });

  it('the language switch goes to the sibling URL, and only on a prefixed page', () => {
    expect(swapLocalePrefix('/ar/products/x', 'en')).toBe('/en/products/x');
    expect(swapLocalePrefix('/en', 'ar')).toBe('/ar');
    expect(swapLocalePrefix('/ar/products', 'ar')).toBeNull();
    expect(swapLocalePrefix('/products', 'en')).toBeNull();
    expect(swapLocalePrefix('/arabic', 'en')).toBeNull();
  });
});

describe('middleware: language in the URL', () => {
  const KEYS = [
    'STOREFRONT_LOCALE_PATHS',
    'STOREFRONT_LOCALE_PATHS_STORES',
    'STOREFRONT_TENANT_ROUTING',
    'STOREFRONT_TENANT_ROUTING_ROUTES',
    'STOREFRONT_TENANT_ROUTING_STORES',
  ] as const;
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    for (const k of KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });
  afterEach(() => {
    for (const k of KEYS)
      saved[k] === undefined ? delete process.env[k] : (process.env[k] = saved[k]);
  });
  const on = () => {
    process.env.STOREFRONT_LOCALE_PATHS = 'true';
    process.env.STOREFRONT_LOCALE_PATHS_STORES = 'demo-boutique,demo-shop.example';
  };
  const req = (host: string, pathname: string, init: { cookie?: string; method?: string } = {}) =>
    new NextRequest(`https://${host}${pathname}`, {
      method: init.method,
      headers: { host, ...(init.cookie ? { cookie: init.cookie } : {}) },
    });
  const sub = (p: string, i?: { cookie?: string; method?: string }) =>
    req('demo-boutique.ebda.app', p, i);
  const fwd = (r: Response, h: string) => r.headers.get(`x-middleware-request-${h}`);

  it('is inert with the flag off or the store unnamed', () => {
    for (const p of ['/products', '/ar/products', '/']) {
      const r = middleware(sub(p));
      expect(r.status).toBe(200);
      expect(r.headers.get('location')).toBeNull();
      expect(fwd(r, 'x-locale-pending')).toBeNull();
      expect(fwd(r, 'x-locale-path')).toBeNull();
    }
    on();
    const other = middleware(req('someone-else.ebda.app', '/products'));
    expect(other.headers.get('location')).toBeNull();
    expect(fwd(other, 'x-locale-pending')).toBeNull();
  });

  it('never redirects off-site: protocol-relative / backslash / encoded tails are refused (Ruling LOCALE-PATHS-3)', () => {
    on();
    const evil = [
      '//evil.com',
      '/\\evil.com',
      '/%2F%2Fevil.com',
      '/%5Cevil.com',
      '/%2f/evil.com',
      '//%5Cevil.com',
      '/\\/evil.com',
      '///evil.com',
      '/x/..%5Cevil.com',
    ];
    for (const l of ['ar', 'en'])
      for (const tail of evil) {
        const r = middleware(sub(`/${l}${tail}`));
        const loc = r.headers.get('location');
        if (loc) {
          expect(new URL(loc, 'https://demo-boutique.ebda.app').origin, `${l}${tail}`).toBe(
            'https://demo-boutique.ebda.app'
          );
        }
        expect(r.status === 301 || r.status === 404 || r.status === 200, `${l}${tail}`).toBe(true);
        expect(loc ?? '', `${l}${tail}`).not.toMatch(/evil\.com/);
      }
    // the legitimate retired-path redirect still works
    const ok = middleware(sub('/ar/cart'));
    expect(ok.status).toBe(301);
    expect(new URL(ok.headers.get('location')!).pathname).toBe('/cart');
  });

  it('marks an old URL pending (the layout redirects it, it has the store) and never caches that response', () => {
    on();
    const r = middleware(sub('/products?category=abayas'));
    expect(r.status).toBe(200);
    expect(fwd(r, 'x-locale-pending')).toBe('1');
    expect(fwd(r, 'x-locale-rest')).toBe('/products');
    expect(fwd(r, 'x-locale-search')).toBe('?category=abayas');
    expect(r.headers.get('cache-control')).toBe('private, no-store');
    expect(fwd(middleware(sub('/')), 'x-locale-pending')).toBe('1');
    // a custom domain is keyed by its hostname
    expect(fwd(middleware(req('demo-shop.example', '/about')), 'x-locale-pending')).toBe('1');
  });

  it('rewrites a prefixed URL to the plain route and asserts the language headers', () => {
    on();
    const r = middleware(sub('/en/products/gold-ring?x=1'));
    expect(r.headers.get('x-middleware-rewrite')).toBe(
      'https://demo-boutique.ebda.app/products/gold-ring?x=1'
    );
    expect(fwd(r, 'x-locale-path')).toBe('en');
    expect(fwd(r, 'x-locale-rest')).toBe('/products/gold-ring');
    expect(fwd(r, 'x-locale-pending')).toBeNull();
    // the URL decides: the cookie follows it
    expect(r.cookies.get('force-language')?.value).toBe('en');
  });

  it('does not touch the cookie when it already matches', () => {
    on();
    const r = middleware(sub('/ar/about', { cookie: 'force-language=ar' }));
    expect(r.cookies.get('force-language')).toBeUndefined();
  });

  it('a prefixed non-route 301s to the plain URL; cart and checkout are never prefixed or marked', () => {
    on();
    const r = middleware(sub('/ar/cart'));
    expect(r.status).toBe(301);
    expect(r.headers.get('location')).toBe('https://demo-boutique.ebda.app/cart');
    for (const p of [
      '/cart',
      '/checkout',
      '/account/orders',
      '/auth/login',
      '/search',
      '/robots.txt',
      '/sitemap.xml',
    ]) {
      const x = middleware(sub(p));
      expect(x.headers.get('location'), p).toBeNull();
      expect(x.headers.get('x-middleware-rewrite'), p).toBeNull();
      expect(fwd(x, 'x-locale-pending'), p).toBeNull();
    }
  });

  it('leaves POST, the admin preview iframe and the demo look preview alone', () => {
    on();
    for (const r of [
      sub('/products', { method: 'POST' }),
      sub('/products?_preview=1'),
      sub('/products?look=qamar.atelier'),
    ]) {
      expect(r && fwd(middleware(r), 'x-locale-pending')).toBeNull();
    }
  });

  it('with the tenant tree on too, a prefixed URL goes to the tree in the URL language, not the cookie', () => {
    on();
    process.env.STOREFRONT_TENANT_ROUTING = 'true';
    process.env.STOREFRONT_TENANT_ROUTING_ROUTES = 'all';
    process.env.STOREFRONT_TENANT_ROUTING_STORES = 'demo-boutique:ar';
    const r = middleware(sub('/en/about', { cookie: 'force-language=ar' }));
    expect(r.headers.get('x-middleware-rewrite')).toBe(
      'https://demo-boutique.ebda.app/tenant-store/demo-boutique.ebda.app/en/about'
    );
  });

  it('a client cannot smuggle the language headers in', () => {
    for (const h of ['x-locale-path', 'x-locale-rest', 'x-locale-pending', 'x-locale-search'])
      expect(MIDDLEWARE_ASSERTED_HEADERS).toContain(h);
    on();
    const spoofed = new NextRequest('https://demo-boutique.ebda.app/cart', {
      headers: { host: 'demo-boutique.ebda.app', 'x-locale-path': 'en', 'x-locale-pending': '1' },
    });
    const r = middleware(spoofed);
    expect(fwd(r, 'x-locale-path')).toBeNull();
    expect(fwd(r, 'x-locale-pending')).toBeNull();
  });
});
