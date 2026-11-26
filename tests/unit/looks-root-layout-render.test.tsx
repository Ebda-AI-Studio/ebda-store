import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { composeStoreTheme } from '@ebda/shared';

// Render the real RootLayout against a look store and a legacy store.
let current: Record<string, unknown>;
vi.mock('next/headers', () => ({
  cookies: async () => ({ get: () => undefined }),
  headers: async () => ({ get: () => null }),
}));
vi.mock('next/font/google', () => {
  const f = (o: { variable: string }) => ({ variable: o.variable });
  return { Plus_Jakarta_Sans: f, IBM_Plex_Sans_Arabic: f, Amiri: f, Marcellus: f };
});
vi.mock('../../apps/web/src/lib/store-resolver', () => ({ getStore: async () => current }));
const { Pass, Null } = vi.hoisted(() => ({
  Pass: ({ children }: { children?: unknown }) => children ?? null,
  Null: () => null,
}));
vi.mock('@ebda/ui', () => ({ ToastProvider: Pass }));
vi.mock('../../apps/web/src/contexts/LanguageContext', () => ({ LanguageProvider: Pass }));
vi.mock('../../apps/web/src/contexts/StoreContext', () => ({ StoreProvider: Pass }));
vi.mock('../../apps/web/src/contexts/CartContext', () => ({ CartProvider: Pass }));
vi.mock('../../apps/web/src/contexts/AuthContext', () => ({ AuthProvider: Pass }));
vi.mock('../../apps/web/src/contexts/FeatureContext', () => ({ FeatureProvider: Pass }));
vi.mock('../../apps/web/src/contexts/ConsentContext', () => ({ ConsentProvider: Pass }));
vi.mock('../../apps/web/src/components/MarketingPixels', () => ({ MarketingPixelsProvider: Pass }));
vi.mock('../../apps/web/src/components/PostHogProvider', () => ({ PostHogProvider: Pass }));
vi.mock('../../apps/web/src/components/ServiceWorkerRegistration', () => ({
  ServiceWorkerRegistration: Null,
}));
vi.mock('../../apps/web/src/components/ScrollToTop', () => ({ ScrollToTop: Null }));
vi.mock('../../apps/web/src/components/SkipLink', () => ({ SkipLink: Null }));
vi.mock('../../apps/web/src/components/PushNotificationPrompt', () => ({
  PushNotificationPrompt: Null,
}));
vi.mock('../../apps/web/src/components/TypographyProbe', () => ({ TypographyProbe: Null }));
vi.mock('../../apps/web/src/components/AffiliateTracker', () => ({ AffiliateTracker: Null }));
vi.mock('../../apps/web/src/components/StoreMaintenance', () => ({ StoreMaintenance: Pass }));
vi.mock('../../apps/web/src/components/CookieConsentBanner', () => ({ CookieConsentBanner: Null }));
vi.mock('../../apps/web/src/components/CookiePreferencesModal', () => ({
  CookiePreferencesModal: Null,
}));
vi.mock('../../apps/web/src/components/CookiePreferencesLink', () => ({
  CookiePreferencesLink: Null,
}));

const { default: RootLayout } = await import('../../apps/web/src/app/layout');

const base = {
  id: 's1',
  name: 'S',
  slug: 's',
  settings: {},
  currency: 'EGP',
  timezone: 'Africa/Cairo',
};
async function html(look: string | null, template = 'qamar') {
  current = {
    ...base,
    look,
    template,
    theme: composeStoreTheme({ template: template as 'qamar', look, theme: {} }),
  };
  return renderToStaticMarkup(await RootLayout({ children: <main>x</main> }));
}

describe('RootLayout: look hooks', () => {
  it('look store: data-look, fonts link, vars', async () => {
    const out = await html('qamar.atelier');
    expect(out).toContain('data-look="qamar.atelier"');
    // SEO-5: self-hosted faces, no Google Fonts request, primary files preloaded.
    expect(out).not.toContain('fonts.googleapis.com');
    expect(out).not.toContain('fonts.gstatic.com');
    expect(out).toMatch(
      /@font-face \{[^}]*font-family: 'Noto Naskh Arabic'[^}]*\/fonts\/look\/[\w.-]+\.woff2/
    );
    expect(out).toMatch(
      /<link rel="preload" as="font" type="font\/woff2" href="\/fonts\/look\/[\w.-]+\.woff2" crossorigin=""/i
    );
    expect(out).toContain('--font-display:');
    expect(out).toContain(
      '--font-latin: &quot;Cormorant Garamond&quot;'.replace('&quot;', '"').replace('&quot;', '"')
    );
    expect(out).toContain('--space-unit: 1.25');
  });
  it('look store with a loadable merchant heading font: the link loads it and the vars use it', async () => {
    current = {
      ...base,
      look: 'qamar.atelier',
      template: 'qamar',
      theme: composeStoreTheme({
        template: 'qamar',
        look: 'qamar.atelier',
        theme: { headingFont: 'Cairo' },
      }),
    };
    const out = renderToStaticMarkup(await RootLayout({ children: <main>x</main> }));
    expect(out).not.toContain('fonts.googleapis.com');
    expect(out).toMatch(/@font-face \{[^}]*font-family: 'Cairo'/);
    expect(out).toContain('--font-display: "Cairo"');
    expect(out).toContain('--font-latin: "Cairo"');
  });
  it('look on the dahab skin: data-pack and data-look both set, look display var emitted', async () => {
    const out = await html('dahab.worn', 'dahab');
    expect(out).toContain('data-pack="dahab"');
    expect(out).toContain('data-look="dahab.worn"');
    expect(out).toMatch(/--look-font-display: "[A-Za-z ]+"/);
  });
  it('a stray density on a legacy store emits no look vars', async () => {
    current = {
      ...base,
      look: null,
      template: 'qamar',
      theme: composeStoreTheme({ template: 'qamar', theme: { density: 'airy' } }),
    };
    const out = renderToStaticMarkup(await RootLayout({ children: <main>x</main> }));
    expect(out).not.toContain('--space-unit');
  });
  it('legacy store: nothing new', async () => {
    for (const look of [null, 'nope.unknown']) {
      const out = await html(look);
      expect(out).not.toContain('data-look');
      expect(out).not.toContain('fonts.googleapis.com/css2?family=Noto');
      expect(out).not.toMatch(
        /--(font-display|font-body|font-latin|space-unit|image-ratio|motion-duration)/
      );
    }
  });
});
