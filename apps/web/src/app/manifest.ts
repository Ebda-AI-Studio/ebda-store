import type { MetadataRoute } from 'next';
import { getStore } from '../lib/store-resolver';
import { API_URL } from '../lib/api';
import { pickMetaDescription } from '../lib/seo/meta-description';
import { resolveStorefrontLocale } from '../lib/seo/resolve-locale';
import { hslToHex } from '@force/shared';

/**
 * Shape of the per-store manifest returned by the API. Mirrors what
 * `apps/api/src/services/pwa.service.ts::generateManifest` builds. Kept
 * loose because the API can evolve fields independently and Next.js
 * `MetadataRoute.Manifest` already enforces the contract for the response.
 */
type ManifestIconPurpose = 'any' | 'maskable' | 'monochrome';

interface ApiManifestIcon {
  src: string;
  sizes: string;
  type: string;
  purpose?: string;
}

interface ApiManifest {
  name?: string;
  short_name?: string;
  description?: string;
  theme_color?: string;
  background_color?: string;
  display?: 'fullscreen' | 'standalone' | 'minimal-ui' | 'browser';
  orientation?: 'any' | 'portrait' | 'landscape';
  start_url?: string;
  scope?: string;
  icons?: ApiManifestIcon[];
}

/**
 * Coerce an icon's `purpose` into the strict union the Next.js manifest type
 * requires. The PWA service may return `purpose: 'maskable'` (or omit it
 * entirely); anything else is dropped so the type contract holds.
 */
function normalizeIcon(icon: ApiManifestIcon): {
  src: string;
  sizes: string;
  type: string;
  purpose?: ManifestIconPurpose;
} {
  const allowed: ManifestIconPurpose[] = ['any', 'maskable', 'monochrome'];
  const purpose =
    icon.purpose && (allowed as string[]).includes(icon.purpose)
      ? (icon.purpose as ManifestIconPurpose)
      : undefined;
  return { src: icon.src, sizes: icon.sizes, type: icon.type, purpose };
}

/**
 * Try to fetch the per-store manifest assembled by the API from the admin's
 * PWA settings. Returns `null` if PWA is disabled for this store, the store
 * id is unknown (demo fallback), or the fetch fails — callers should then
 * fall back to the basic manifest derived from generic store fields.
 */
async function fetchStoreManifest(storeId: string): Promise<ApiManifest | null> {
  if (!storeId || storeId === 'demo') return null;
  try {
    const res = await fetch(`${API_URL}/public/${storeId}/manifest.json`, {
      // Tagged so an icon/settings write (PWAService.updateSettings) can bust
      // this immediately via revalidateStorefront({tags:[`pwa:<storeId>`]})
      // instead of merchants waiting out the 300s TTL — same pattern as the
      // products/categories tags this fetch's siblings use.
      next: { revalidate: 300, tags: [`pwa:${storeId}`] },
      headers: { 'Content-Type': 'application/json' },
    });
    if (!res.ok) return null;
    return (await res.json()) as ApiManifest;
  } catch (error) {
    console.error('Failed to fetch per-store PWA manifest:', error);
    return null;
  }
}

export default async function manifest(): Promise<MetadataRoute.Manifest> {
  const store = await getStore();
  const primaryColor = store.theme?.primaryColor || '#ff6e00';
  const fallbackThemeColor = hslToHex(primaryColor);
  const storeDefaultLanguage = (store.settings as Record<string, unknown> | undefined)
    ?.defaultLanguage as string | undefined;
  const locale = await resolveStorefrontLocale(storeDefaultLanguage);
  const localizedStoreDescriptionFallback =
    locale === 'ar' ? `تسوق في ${store.name}` : `Shop at ${store.name}`;

  // When the admin has enabled PWA and saved app-name / icons / theme color
  // for the store, the API returns a manifest already shaped for that store.
  // We forward those fields verbatim so the install prompt and home-screen
  // icon use the per-tenant branding instead of the generic defaults below.
  const apiManifest = await fetchStoreManifest(store.id);

  if (apiManifest) {
    return {
      name: apiManifest.name || store.name,
      short_name: apiManifest.short_name || store.name,
      description: apiManifest.description || localizedStoreDescriptionFallback,
      start_url: apiManifest.start_url || '/',
      display: apiManifest.display || 'standalone',
      orientation: apiManifest.orientation || 'any',
      background_color: apiManifest.background_color || '#ffffff',
      theme_color: apiManifest.theme_color || fallbackThemeColor,
      scope: apiManifest.scope || '/',
      icons:
        apiManifest.icons && apiManifest.icons.length > 0
          ? apiManifest.icons.map(normalizeIcon)
          : store.favicon
            ? [
                { src: store.favicon, sizes: '192x192', type: 'image/png' },
                { src: store.favicon, sizes: '512x512', type: 'image/png' },
              ]
            : [
                { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
                { src: '/icon-512.png', sizes: '512x512', type: 'image/png' },
              ],
    };
  }

  return {
    name: store.name,
    short_name: store.name,
    description: pickMetaDescription(store, locale) || localizedStoreDescriptionFallback,
    start_url: '/',
    display: 'standalone',
    background_color: '#ffffff',
    theme_color: fallbackThemeColor,
    icons: [
      ...(store.favicon
        ? [
            { src: store.favicon, sizes: '192x192', type: 'image/png' },
            { src: store.favicon, sizes: '512x512', type: 'image/png' },
          ]
        : [
            { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
            { src: '/icon-512.png', sizes: '512x512', type: 'image/png' },
          ]),
    ],
  };
}
