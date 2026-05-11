import type { MetadataRoute } from 'next';

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
 * per-store manifest at apps/web/src/app/manifest.ts.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'Force Store Admin',
    short_name: 'Force Admin',
    description: 'Force Website Builder operator console',
    start_url: '/',
    scope: '/',
    display: 'standalone',
    orientation: 'any',
    background_color: '#ffffff',
    theme_color: '#FF6E00',
    icons: [
      {
        src: '/favicon.svg',
        sizes: 'any',
        type: 'image/svg+xml',
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
    categories: ['business', 'productivity'],
  };
}
