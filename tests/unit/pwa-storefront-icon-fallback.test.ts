/**
 * Storefront icon fallback-chain unit tests (B5 plan task 5).
 *
 * Binding requirement: apple-touch-icon and favicons fall back to the
 * PRE-EXISTING icon chain when the new B5 fields (iconAppleTouch, favicon32,
 * favicon16) are unset — which is the case for every one of the 3 live
 * storefronts today. Nothing may change for them until a merchant uploads a
 * new icon. This locks the "unset → identical to before" case with an exact
 * `toEqual`, then proves the new fields DO take priority once set.
 */
import { describe, it, expect } from 'vitest';
import { buildStorefrontMetadata } from '@web/lib/storefront-metadata';
import type { ResolvedStore } from '@web/lib/store-resolver';

function baseStore(overrides: Partial<ResolvedStore> = {}): ResolvedStore {
  return {
    id: 'store-1',
    name: 'Palora',
    slug: 'palora',
    status: 'active',
    currency: 'KWD',
    timezone: 'Asia/Kuwait',
    template: 'modern',
    theme: {} as ResolvedStore['theme'],
    socialLinks: {} as ResolvedStore['socialLinks'],
    settings: {},
    ...overrides,
  } as ResolvedStore;
}

describe('buildStorefrontMetadata — PWA icon fallback chain', () => {
  it('LEGACY (no B5 fields at all): favicon = store.favicon, no apple-touch icon', () => {
    const store = baseStore({
      favicon: 'https://cdn.example.com/favicon.png',
      logo: 'https://cdn.example.com/logo.png',
      pwaEnabled: true,
      pwaSettings: { icon192: 'https://cdn.example.com/icon192.png' },
      enabledFeatures: ['pwa'],
    });

    const metadata = buildStorefrontMetadata(store, false);

    expect(metadata.icons).toEqual({
      icon: 'https://cdn.example.com/favicon.png',
      apple: 'https://cdn.example.com/icon192.png',
    });
  });

  it('LEGACY, pwa disabled: favicon still resolves, no apple key at all', () => {
    const store = baseStore({
      favicon: 'https://cdn.example.com/favicon.png',
      pwaEnabled: false,
    });

    const metadata = buildStorefrontMetadata(store, false);

    expect(metadata.icons).toEqual({ icon: 'https://cdn.example.com/favicon.png' });
  });

  it('B5 apple-touch icon set: wins over the maskable/512/192 fallback chain', () => {
    const store = baseStore({
      favicon: 'https://cdn.example.com/favicon.png',
      pwaEnabled: true,
      enabledFeatures: ['pwa'],
      pwaSettings: {
        iconAppleTouch: 'https://cdn.example.com/apple-touch-180.png',
        maskableIcon: 'https://cdn.example.com/maskable.png',
        icon512: 'https://cdn.example.com/icon512.png',
      },
    });

    const metadata = buildStorefrontMetadata(store, false);

    expect((metadata.icons as { apple?: string }).apple).toBe(
      'https://cdn.example.com/apple-touch-180.png'
    );
  });

  it('B5 favicon32/16 set: overrides icons.icon with a sized array', () => {
    const store = baseStore({
      favicon: 'https://cdn.example.com/legacy-favicon.png',
      pwaEnabled: true,
      enabledFeatures: ['pwa'],
      pwaSettings: {
        favicon32: 'https://cdn.example.com/favicon-32.png',
        favicon16: 'https://cdn.example.com/favicon-16.png',
      },
    });

    const metadata = buildStorefrontMetadata(store, false);

    expect((metadata.icons as { icon?: unknown }).icon).toEqual([
      { url: 'https://cdn.example.com/favicon-32.png', sizes: '32x32', type: 'image/png' },
      { url: 'https://cdn.example.com/favicon-16.png', sizes: '16x16', type: 'image/png' },
    ]);
  });

  it('B5 fields present but pwa feature-flagged OFF: falls back to the legacy favicon/no-apple behavior', () => {
    const store = baseStore({
      favicon: 'https://cdn.example.com/favicon.png',
      pwaEnabled: true,
      enabledFeatures: [], // platform disabled 'pwa' for this store
      pwaSettings: {
        iconAppleTouch: 'https://cdn.example.com/apple-touch-180.png',
        favicon32: 'https://cdn.example.com/favicon-32.png',
      },
    });

    const metadata = buildStorefrontMetadata(store, false);

    expect(metadata.icons).toEqual({ icon: 'https://cdn.example.com/favicon.png' });
  });
});
