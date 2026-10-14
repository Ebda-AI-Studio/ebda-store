import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { composeStoreTheme } from '@force/shared';

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
vi.mock('@force/ui', () => ({ ToastProvider: Pass }));
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
vi.mock('../../apps/web/src/components/PushNotificationPrompt', () => ({
  PushNotificationPrompt: Null,
}));
vi.mock('../../apps/web/src/components/OneSignalStorefrontInit', () => ({
  OneSignalStorefrontInit: Null,
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
async function html(look: string | null) {
  current = {
    ...base,
    look,
    template: 'minimal',
    theme: composeStoreTheme({ template: 'minimal', look, theme: {} }),
  };
  return renderToStaticMarkup(await RootLayout({ children: <main>x</main> }));
}

describe('RootLayout: look hooks', () => {
  it('look store: data-look, fonts link, vars', async () => {
    const out = await html('qamar.atelier');
    expect(out).toContain('data-look="qamar.atelier"');
    expect(out).toContain('https://fonts.googleapis.com/css2?family=Noto+Naskh+Arabic');
    expect(out).toContain('--font-display:');
    expect(out).toContain(
      '--font-latin: &quot;Cormorant Garamond&quot;'.replace('&quot;', '"').replace('&quot;', '"')
    );
    expect(out).toContain('--space-unit: 1.25');
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
