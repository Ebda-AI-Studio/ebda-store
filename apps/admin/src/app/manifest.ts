import type { MetadataRoute } from 'next';
import { BRAND } from '@ebda/shared';
import { getLocale, getTranslations } from 'next-intl/server';
import { productName } from '../lib/product-name';

/**
 * Admin PWA manifest. Why this matters:
 * - iOS Safari only grants Web Push permission to **installed** PWAs.
 *   Without a manifest + apple-touch-icon + an `Add to Home Screen` install,
 *   OneSignal browser push silently fails on iPhone.
 * - Once installed, the admin app behaves like a native app: standalone
 *   display, splash screen from theme_color, push pings work.
 *
 * Single-tenant manifest: this is the operator console, not a per-store
 * surface, so the values are constant. The storefront keeps its own
 * per-store manifest at apps/web/src/lib/pwa/store-manifest.ts.
 */
export default async function manifest(): Promise<MetadataRoute.Manifest> {
  const locale = await getLocale();
  const t = await getTranslations('pwa.appManifest');
  const name = productName(locale);
  return {
    name,
    short_name: name,
    description: t('description'),
    lang: locale,
    dir: locale === 'ar' ? 'rtl' : 'ltr',
    start_url: '/',
    scope: '/',
    display: 'standalone',
    orientation: 'any',
    background_color: BRAND.colors.night,
    theme_color: BRAND.colors.night,
    icons: [
      {
        src: '/favicon.svg',
        sizes: 'any',
        type: 'image/svg+xml',
        purpose: 'any',
      },
      {
        src: '/icon-192.png',
        sizes: '192x192',
        type: 'image/png',
        purpose: 'any',
      },
      {
        src: '/icon.png',
        sizes: '512x512',
        type: 'image/png',
        purpose: 'any',
      },
      {
        src: '/icon-192x192.png',
        sizes: '192x192',
        type: 'image/png',
        purpose: 'maskable',
      },
      {
        src: '/icon-384x384.png',
        sizes: '384x384',
        type: 'image/png',
        purpose: 'maskable',
      },
      {
        src: '/icon-512x512.png',
        sizes: '512x512',
        type: 'image/png',
        purpose: 'maskable',
      },
      {
        src: '/apple-touch-icon.png',
        sizes: '180x180',
        type: 'image/png',
        purpose: 'any',
      },
    ],
    // Focus-mode shortcut: install the admin PWA, long-press its icon (Android)
    // or use the shortcuts list, and pick "Orders Focus" to land straight in
    // the orders-only station without going through the full dashboard.
    shortcuts: [
      {
        name: 'Orders Focus',
        short_name: 'Orders',
        description: 'Jump straight to focus mode — orders-only view',
        url: '/?focus=1',
        icons: [
          {
            src: '/icon-192x192.png',
            sizes: '192x192',
            type: 'image/png',
          },
        ],
      },
    ],
    categories: ['business', 'productivity'],
  };
}
