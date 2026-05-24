import type { MetadataRoute } from 'next';
import { getStore } from '../lib/store-resolver';
import { API_URL } from '../lib/api';
import { pickMetaDescription } from '../lib/seo/meta-description';

/**
 * Convert HSL string (e.g. "26 100% 50%") to hex color.
 * Falls back to the input if it's already a hex color or can't be parsed.
 */
function hslToHex(hsl: string): string {
  if (hsl.startsWith('#')) return hsl;
  const parts = hsl.match(/(\d+(?:\.\d+)?)/g);
  if (!parts || parts.length < 3) return '#ff6e00';
  const h = parseFloat(parts[0]) / 360;
  const s = parseFloat(parts[1]) / 100;
  const l = parseFloat(parts[2]) / 100;
  const hue2rgb = (p: number, q: number, t: number) => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const r = Math.round(hue2rgb(p, q, h + 1 / 3) * 255);
  const g = Math.round(hue2rgb(p, q, h) * 255);
  const b = Math.round(hue2rgb(p, q, h - 1 / 3) * 255);
  return `#${((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1)}`;
}

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
      next: { revalidate: 300 },
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

  // When the admin has enabled PWA and saved app-name / icons / theme color
  // for the store, the API returns a manifest already shaped for that store.
  // We forward those fields verbatim so the install prompt and home-screen
  // icon use the per-tenant branding instead of the generic defaults below.
  const apiManifest = await fetchStoreManifest(store.id);

  if (apiManifest) {
    return {
      name: apiManifest.name || store.name,
      short_name: apiManifest.short_name || store.name,
      description: apiManifest.description || `Shop at ${store.name}`,
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
    description: pickMetaDescription(store) || `Shop at ${store.name}`,
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
