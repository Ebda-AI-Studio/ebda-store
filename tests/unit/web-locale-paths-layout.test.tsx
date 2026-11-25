/**
 * LOCALE-PATHS-1: the root layout turns the middleware's `x-locale-pending` mark into the redirect, using the store's OWN
 * `settings.defaultLanguage` (read at request time), so the target can never disagree with the store. And on a prefixed
 * page `<html lang>`/`dir` follow the URL, and the Organization JSON-LD names the prefixed URL.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

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
const reqHeaders: Record<string, string> = {};

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
  headers: async () =>
    new Headers({ host: 'demo-shop.example', 'x-is-platform': '0', ...reqHeaders }),
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

const PAGE = <main data-test-page="">page</main>;

async function digestOf(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (e) {
    return String((e as { digest?: string }).digest ?? e);
  }
  return 'no redirect';
}

describe('root layout: old URL redirect (x-locale-pending)', () => {
  beforeEach(() => {
    for (const k of Object.keys(reqHeaders)) delete reqHeaders[k];
    languageCookie.value = undefined;
    STORE.settings.defaultLanguage = 'ar';
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{}', { status: 404 }))
    );
  });
  const pending = (rest = '/products', search = '?sort=price') => {
    reqHeaders['x-locale-pending'] = '1';
    reqHeaders['x-locale-rest'] = rest;
    reqHeaders['x-locale-search'] = search;
  };

  it('permanent redirect to the store default language, query kept', async () => {
    pending();
    const d = await digestOf(() => RootLayout({ children: PAGE }));
    expect(d).toBe('NEXT_REDIRECT;replace;/ar/products?sort=price;308;');
  });

  it('the target follows settings.defaultLanguage: nothing is configured per store', async () => {
    pending('/about', '');
    STORE.settings.defaultLanguage = 'en';
    expect(await digestOf(() => RootLayout({ children: PAGE }))).toBe(
      'NEXT_REDIRECT;replace;/en/about;308;'
    );
    STORE.settings.defaultLanguage = 'ar';
    expect(await digestOf(() => RootLayout({ children: PAGE }))).toBe(
      'NEXT_REDIRECT;replace;/ar/about;308;'
    );
  });

  it('the home redirects to the bare prefix', async () => {
    pending('/', '');
    expect(await digestOf(() => RootLayout({ children: PAGE }))).toBe(
      'NEXT_REDIRECT;replace;/ar;308;'
    );
  });

  it('a cookie for the other language gets a temporary redirect to it', async () => {
    pending('/faq', '');
    languageCookie.value = 'en';
    expect(await digestOf(() => RootLayout({ children: PAGE }))).toBe(
      'NEXT_REDIRECT;replace;/en/faq;307;'
    );
  });

  it('no mark, no redirect (an ordinary page, or a store with the flag off)', async () => {
    expect(await digestOf(() => RootLayout({ children: PAGE }))).toBe('no redirect');
  });
});

describe('root layout: a prefixed page', () => {
  beforeEach(() => {
    for (const k of Object.keys(reqHeaders)) delete reqHeaders[k];
    languageCookie.value = 'ar';
    STORE.settings.defaultLanguage = 'ar';
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{}', { status: 404 }))
    );
  });

  it('<html lang> and dir follow the URL, not the cookie or the store default', async () => {
    reqHeaders['x-locale-path'] = 'en';
    reqHeaders['x-locale-rest'] = '/products';
    const html = renderToStaticMarkup(await RootLayout({ children: PAGE }));
    expect(html).toMatch(/<html lang="en" dir="ltr"/);
  });

  it('the Organization JSON-LD names the prefixed home URL', async () => {
    reqHeaders['x-locale-path'] = 'ar';
    reqHeaders['x-locale-rest'] = '/';
    const html = renderToStaticMarkup(await RootLayout({ children: PAGE }));
    const org = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)]
      .map(m => m[1])
      .find(j => /"@type":"Organization"/.test(j))!;
    const urls = [...org.matchAll(/"url":"(https:\/\/demo-shop\.example[^"]*)"/g)].map(m => m[1]);
    expect(urls.length).toBeGreaterThan(0);
    for (const u of urls) expect(u, u).toMatch(/^https:\/\/demo-shop\.example\/(ar|en)(\/|$)/);
  });

  it('an ordinary page keeps its URLs as they were', async () => {
    const html = renderToStaticMarkup(await RootLayout({ children: PAGE }));
    expect(html).not.toMatch(/https:\/\/demo-shop\.example\/ar/);
  });
});
