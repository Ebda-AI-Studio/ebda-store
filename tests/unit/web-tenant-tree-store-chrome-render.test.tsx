/**
 * Render test for issue #709: when tenant routing flips for a store, the
 * marketing pixels, the Organization JSON-LD and the theme `<style>` must
 * render EXACTLY ONCE, the same as with the flag off.
 *
 * - Flag OFF (production today): a storefront page is the legacy
 *   `app/layout.tsx` around the page.
 * - Flag ON: `middleware.ts` rewrites the request into
 *   `/tenant-store/[tenant]/[locale]/…`, so the page is the tenant-store
 *   layout nested INSIDE the same root layout (Next allows one root layout).
 *
 * Both real layouts are rendered and composed the way Next composes them. The
 * source-level guard in web-tenant-tree-single-pixel-writer.test.ts checks
 * WHO owns the chrome; this checks what reaches the HTML, so it also catches
 * "zero writers" (the root stops emitting and the tenant layout still defers).
 *
 * Mocks cover only request context (cookies/headers), the store fetch, fonts
 * and client providers that render nothing store-specific. The pixel provider
 * is replaced by a marker, and `ConsentGatedMarketingPixels` by the provider
 * it mounts once its consent effect runs: server rendering never runs effects,
 * so the real component would render nothing and hide a second writer.
 *
 * String counts over server-rendered HTML, as in the other render tests here
 * (no jsdom / testing-library in this repo).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { NextRequest } from 'next/server';
import { middleware } from '../../apps/web/middleware';

const WEB = '../../apps/web/src';

const STORE = {
  id: 'store-1',
  name: 'Demo Shop',
  slug: 'demo-shop',
  domain: 'demo-shop.example',
  status: 'active',
  description: 'Nuts and dates',
  theme: { primaryColor: '#123456' },
  typography: null,
  settings: { defaultLanguage: 'ar' as 'ar' | 'en' },
  marketingPixels: { meta: { pixelId: '1234567890' } },
  pwaEnabled: false,
  enabledFeatures: [],
};

// Mutable so the metadata parity cases can vary the language cookie.
const languageCookie: { value?: string } = {};

vi.mock('next/headers', () => ({
  cookies: async () => {
    const jar: Record<string, string> = {
      'force-cookie-consent': encodeURIComponent(
        JSON.stringify({ v: 1, necessary: true, analytics: true, marketing: true })
      ),
      ...(languageCookie.value ? { 'force-language': languageCookie.value } : {}),
    };
    return { get: (name: string) => (name in jar ? { name, value: jar[name] } : undefined) };
  },
  headers: async () => new Headers({ host: 'demo-shop.example', 'x-is-platform': '0' }),
}));

vi.mock('next/font/google', () => ({
  Plus_Jakarta_Sans: () => ({ variable: 'font-sans-var' }),
  IBM_Plex_Sans_Arabic: () => ({ variable: 'font-arabic-var' }),
  Amiri: () => ({ variable: 'font-dahab-ar-var' }),
  Marcellus: () => ({ variable: 'font-dahab-latin-var' }),
}));

vi.mock('../../apps/web/src/lib/store-resolver', () => ({
  getStore: async () => STORE,
  getStoreByTenantParam: async () => STORE,
}));

const passthrough = ({ children }: { children?: React.ReactNode }) => <>{children}</>;
const nothing = () => null;

vi.mock('@ebda/ui', () => ({ ToastProvider: passthrough }));
vi.mock('../../apps/web/src/contexts/LanguageContext', () => ({ LanguageProvider: passthrough }));
vi.mock('../../apps/web/src/contexts/StoreContext', () => ({ StoreProvider: passthrough }));
vi.mock('../../apps/web/src/contexts/CartContext', () => ({ CartProvider: passthrough }));
vi.mock('../../apps/web/src/contexts/AuthContext', () => ({ AuthProvider: passthrough }));
vi.mock('../../apps/web/src/contexts/FeatureContext', () => ({ FeatureProvider: passthrough }));
vi.mock('../../apps/web/src/contexts/ConsentContext', () => ({ ConsentProvider: passthrough }));
vi.mock('../../apps/web/src/components/PostHogProvider', () => ({ PostHogProvider: passthrough }));
vi.mock('../../apps/web/src/components/ServiceWorkerRegistration', () => ({
  ServiceWorkerRegistration: nothing,
}));
vi.mock('../../apps/web/src/components/ScrollToTop', () => ({ ScrollToTop: nothing }));
vi.mock('../../apps/web/src/components/SkipLink', () => ({ SkipLink: nothing }));
vi.mock('../../apps/web/src/components/PushNotificationPrompt', () => ({
  PushNotificationPrompt: nothing,
}));
vi.mock('../../apps/web/src/components/TypographyProbe', () => ({ TypographyProbe: nothing }));
vi.mock('../../apps/web/src/components/AffiliateTracker', () => ({ AffiliateTracker: nothing }));
vi.mock('../../apps/web/src/components/StoreMaintenance', () => ({ StoreMaintenance: nothing }));
vi.mock('../../apps/web/src/components/CookieConsentBanner', () => ({
  CookieConsentBanner: nothing,
}));
vi.mock('../../apps/web/src/components/CookiePreferencesModal', () => ({
  CookiePreferencesModal: nothing,
}));
vi.mock('../../apps/web/src/components/CookiePreferencesLink', () => ({
  CookiePreferencesLink: nothing,
}));

const PIXEL_MARKER = 'data-test-pixel-provider';
vi.mock('../../apps/web/src/components/MarketingPixels', () => ({
  MarketingPixelsProvider: () => <i {...{ [PIXEL_MARKER]: '' }} />,
}));
vi.mock(
  '../../apps/web/src/app/tenant-store/[tenant]/[locale]/ConsentGatedMarketingPixels',
  () => ({
    ConsentGatedMarketingPixels: () => <i {...{ [PIXEL_MARKER]: '' }} />,
  })
);

const { default: RootLayout } = await import(`${WEB}/app/layout`);
const { default: TenantStoreLayout } = await import(
  `${WEB}/app/tenant-store/[tenant]/[locale]/layout`
);

const { generateMetadata: rootMetadata } = await import(`${WEB}/app/layout`);
const { generateMetadata: tenantLayoutMetadata } = await import(
  `${WEB}/app/tenant-store/[tenant]/[locale]/layout`
);

const PAGE = <main data-test-page="">page</main>;

/** Flag off: the legacy tree, root layout around the page. */
async function renderFlagOff(): Promise<string> {
  return renderToStaticMarkup(await RootLayout({ children: PAGE }));
}

/** Flag on: the tenant-store layout nested inside the root layout. */
async function renderFlagOn(): Promise<string> {
  const tenantTree = await TenantStoreLayout({
    children: PAGE,
    params: Promise.resolve({ tenant: 'demo-shop.example', locale: 'ar' }),
  });
  return renderToStaticMarkup(await RootLayout({ children: tenantTree }));
}

const count = (html: string, needle: string) => html.split(needle).length - 1;

/** ld+json blocks whose payload is an Organization node. */
const organizationJsonLdBlocks = (html: string) =>
  [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].filter(m =>
    /"@type":"Organization"/.test(m[1])
  ).length;

describe('store chrome renders exactly once, flag off and flag on (#709)', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{}', { status: 404 }))
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  for (const [label, render] of [
    ['flag off (legacy tree)', renderFlagOff],
    ['flag on (tenant-store tree)', renderFlagOn],
  ] as const) {
    describe(label, () => {
      it('renders the page exactly once', async () => {
        expect(count(await render(), 'data-test-page')).toBe(1);
      });

      it('mounts the marketing pixel provider exactly once', async () => {
        expect(count(await render(), PIXEL_MARKER)).toBe(1);
      });

      it('emits the Organization JSON-LD exactly once', async () => {
        expect(organizationJsonLdBlocks(await render())).toBe(1);
      });

      it('emits the theme <style> exactly once', async () => {
        expect(count(await render(), '<style')).toBe(1);
      });
    });
  }

  it('flag on renders the same store chrome as flag off', async () => {
    const off = await renderFlagOff();
    const on = await renderFlagOn();
    const head = (html: string) => html.slice(html.indexOf('<head>'), html.indexOf('</head>'));
    expect(head(on)).toBe(head(off));
  });
});

/**
 * Issue 2407. Next merges metadata root -> nested layout, the deeper segment
 * winning per key, so flag on the document metadata is {...root, ...tenant}.
 * Middleware bakes `[locale]` from the cookie alone (`en` when absent), so the
 * route segment for a cookie-less visitor is `en` on an Arabic-default store
 * even though the root resolves `ar`. The merged metadata must equal the flag-off
 * (root only) metadata for every cookie state, or crawlers index English
 * titles / og:locale over an Arabic <html lang>.
 */
describe('document metadata is identical flag off and flag on (issue 2407)', () => {
  afterEach(() => {
    languageCookie.value = undefined;
  });

  const middlewareSegment = (cookie: string | undefined) => (cookie === 'ar' ? 'ar' : 'en');

  for (const cookie of [undefined, 'en', 'ar']) {
    it(`force-language=${cookie ?? '(none)'} on an Arabic-default store`, async () => {
      languageCookie.value = cookie;
      const off = await rootMetadata();
      const nested = await tenantLayoutMetadata({
        params: Promise.resolve({ tenant: 'demo-shop.example', locale: middlewareSegment(cookie) }),
      });
      const on = { ...off, ...nested };
      expect(on).toEqual(off);
    });
  }

  it('the root resolves ar for a cookie-less visitor (the case the route segment gets wrong)', async () => {
    languageCookie.value = undefined;
    const md = await rootMetadata();
    expect(JSON.stringify(md)).toContain('ar_EG');
  });
});

/**
 * Issue 2419 / Ruling TRC-7, end to end through the allowlist. The rewrite
 * (real middleware) picks the `[locale]` segment; the merged document metadata
 * is {...root, ...tenant layout} for THAT segment. With routing on for a store
 * in the allowlist, the document language must be the one the visitor gets with
 * routing off: cookie, else the store's default.
 */
describe('allowlisted store: route segment and metadata agree with the store default (issue 2419)', () => {
  const ENV_KEYS = [
    'STOREFRONT_TENANT_ROUTING',
    'STOREFRONT_TENANT_ROUTING_ROUTES',
    'STOREFRONT_TENANT_ROUTING_STORES',
  ] as const;
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const k of ENV_KEYS) saved[k] = process.env[k];
    process.env.STOREFRONT_TENANT_ROUTING = 'true';
    process.env.STOREFRONT_TENANT_ROUTING_ROUTES = 'about';
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    languageCookie.value = undefined;
    STORE.settings.defaultLanguage = 'ar';
  });

  /** The `[locale]` the real middleware bakes for a visit to /about. */
  function routeSegment(storesToken: string, cookie: string | undefined): string {
    process.env.STOREFRONT_TENANT_ROUTING_STORES = storesToken;
    const res = middleware(
      new NextRequest('https://demo-shop.example/about', {
        headers: {
          host: 'demo-shop.example',
          ...(cookie ? { cookie: `force-language=${cookie}` } : {}),
        },
      })
    );
    const rewrite = res.headers.get('x-middleware-rewrite') ?? '';
    expect(rewrite, 'the allowlisted store must be rewritten').toContain('/tenant-store/');
    return new URL(rewrite).pathname.split('/')[3];
  }

  const ogLocale = (md: any): string | undefined => md.openGraph?.locale;

  async function mergedMetadata(segment: string) {
    const off = await rootMetadata();
    const nested = await tenantLayoutMetadata({
      params: Promise.resolve({ tenant: 'demo-shop.example', locale: segment }),
    });
    return { off, on: { ...off, ...nested } };
  }

  it('AR-default store, no cookie: the route key is ar and the metadata is Arabic', async () => {
    STORE.settings.defaultLanguage = 'ar';
    const segment = routeSegment('demo-shop.example:ar', undefined);
    expect(segment).toBe('ar');
    const { off, on } = await mergedMetadata(segment);
    expect(ogLocale(on)).toBe('ar_EG');
    expect(on).toEqual(off);
  });

  it('AR-default store, en cookie: the route key is en and the metadata is English', async () => {
    STORE.settings.defaultLanguage = 'ar';
    languageCookie.value = 'en';
    const segment = routeSegment('demo-shop.example:ar', 'en');
    expect(segment).toBe('en');
    const { off, on } = await mergedMetadata(segment);
    expect(ogLocale(on)).toBe('en_US');
    expect(on).toEqual(off);
  });

  it('EN-default store, no cookie: the route key is en and the metadata is English', async () => {
    STORE.settings.defaultLanguage = 'en';
    const segment = routeSegment('demo-shop.example', undefined);
    expect(segment).toBe('en');
    const { off, on } = await mergedMetadata(segment);
    expect(ogLocale(on)).toBe('en_US');
    expect(on).toEqual(off);
  });
});
