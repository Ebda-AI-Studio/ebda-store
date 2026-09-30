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

const WEB = '../../apps/web/src';

const STORE = {
  id: 'store-1',
  name: 'Wady Al Juz',
  slug: 'wadyaljuz',
  domain: 'wadyaljuz.com',
  status: 'active',
  description: 'Nuts and dates',
  theme: { primaryColor: '#123456' },
  typography: null,
  settings: { defaultLanguage: 'ar' },
  marketingPixels: { meta: { pixelId: '1234567890' } },
  pwaEnabled: false,
  enabledFeatures: [],
};

vi.mock('next/headers', () => ({
  cookies: async () => {
    const jar: Record<string, string> = {
      'force-cookie-consent': encodeURIComponent(
        JSON.stringify({ v: 1, necessary: true, analytics: true, marketing: true })
      ),
    };
    return { get: (name: string) => (name in jar ? { name, value: jar[name] } : undefined) };
  },
  headers: async () => new Headers({ host: 'wadyaljuz.com', 'x-is-platform': '0' }),
}));

vi.mock('next/font/google', () => ({
  Plus_Jakarta_Sans: () => ({ variable: 'font-sans-var' }),
  IBM_Plex_Sans_Arabic: () => ({ variable: 'font-arabic-var' }),
}));

vi.mock('../../apps/web/src/lib/store-resolver', () => ({
  getStore: async () => STORE,
  getStoreByTenantParam: async () => STORE,
}));

const passthrough = ({ children }: { children?: React.ReactNode }) => <>{children}</>;
const nothing = () => null;

vi.mock('@force/ui', () => ({ ToastProvider: passthrough }));
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
vi.mock('../../apps/web/src/components/PushNotificationPrompt', () => ({
  PushNotificationPrompt: nothing,
}));
vi.mock('../../apps/web/src/components/OneSignalStorefrontInit', () => ({
  OneSignalStorefrontInit: nothing,
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

const PAGE = <main data-test-page="">page</main>;

/** Flag off: the legacy tree, root layout around the page. */
async function renderFlagOff(): Promise<string> {
  return renderToStaticMarkup(await RootLayout({ children: PAGE }));
}

/** Flag on: the tenant-store layout nested inside the root layout. */
async function renderFlagOn(): Promise<string> {
  const tenantTree = await TenantStoreLayout({
    children: PAGE,
    params: Promise.resolve({ tenant: 'wadyaljuz.com', locale: 'ar' }),
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
