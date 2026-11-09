import type { MetadataRoute } from 'next';
import { getStore } from '../lib/store-resolver';
import { API_URL } from '../lib/api';
import { pickMetaDescription } from '../lib/seo/meta-description';
import { resolveStorefrontLocale } from '../lib/seo/resolve-locale';
import { hslToHex, BRAND, storePwaManifestSchema, type StorePwaManifest } from '@ebda/shared';

type ManifestIconPurpose = 'any' | 'maskable' | 'monochrome';

/** The per-store manifest the API builds, after it passed `storePwaManifestSchema` (@ebda/shared). */
type ApiManifest = StorePwaManifest;
type ApiManifestIcon = NonNullable<ApiManifest['icons']>[number];

/** A manifest is never worth holding a render for: past this the generic manifest is served instead. */
const MANIFEST_FETCH_TIMEOUT_MS = 3000;

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
 * PWA settings. Returns `null` when PWA is disabled for this store, the store
 * id is unknown (demo fallback), the fetch fails or times out, or the answer
 * fails `storePwaManifestSchema`. The caller then serves the generic manifest
 * built from the store's own fields, so a broken merchant manifest is never
 * worse than no merchant manifest.
 */
async function fetchStoreManifest(storeId: string): Promise<ApiManifest | null> {
  if (!storeId || storeId === 'demo') return null;
  try {
    // The PWA router is mounted at `/stores` (apps/api/src/routes/index.ts). `/public/<id>/manifest.json` is no route at
    // all: it answered 404 on every render, so the per-store manifest never applied and each miss was charged to the
    // per-IP store-miss budget on the public router.
    const res = await fetch(`${API_URL}/stores/public/${storeId}/manifest.json`, {
      // Tagged so an icon/settings write (PWAService.updateSettings) can bust
      // this immediately via revalidateStorefront({tags:[`pwa:<storeId>`]})
      // instead of merchants waiting out the 300s TTL — same pattern as the
      // products/categories tags this fetch's siblings use.
      next: { revalidate: 300, tags: [`pwa:${storeId}`] },
      headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(MANIFEST_FETCH_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    // Merchant input, read at the edge: start_url/scope must stay on the store's own origin, every icon must be an
    // absolute https URL, colours must be hex. One bad field refuses the whole manifest rather than serving half of it.
    const parsed = storePwaManifestSchema.safeParse(await res.json());
    if (!parsed.success) {
      console.warn(
        'Per-store PWA manifest refused, serving the generic one:',
        storeId,
        parsed.error.issues.map(issue => issue.path.join('.')).join(', ')
      );
      return null;
    }
    return parsed.data;
  } catch (error) {
    console.error('Failed to fetch per-store PWA manifest:', error);
    return null;
  }
}

export default async function manifest(): Promise<MetadataRoute.Manifest> {
  const store = await getStore();
  const primaryColor = store.theme?.primaryColor || BRAND.colors.gold;
  const fallbackThemeColor = hslToHex(primaryColor);
  // `DEFAULT_STORE` sentinel (store-resolver.ts): no merchant resolved → platform.
  const isPlatformDefault = store.id === 'demo' && !store.favicon;
  const storeDefaultLanguage = (store.settings as Record<string, unknown> | undefined)
    ?.defaultLanguage as string | undefined;
  const locale = await resolveStorefrontLocale(storeDefaultLanguage);
  // Arabic locale reads the merchant's Arabic name when present (issue
  // #1857) — else this fallback description interpolates the English name
  // under `<html lang="ar">`.
  const localizedStoreName = locale === 'ar' ? store.nameAr?.trim() || store.name : store.name;
  const localizedStoreDescriptionFallback =
    locale === 'ar' ? `تسوق في ${localizedStoreName}` : `Shop at ${localizedStoreName}`;

  // When the admin has enabled PWA and saved app-name / icons / theme color
  // for the store, the API returns a manifest already shaped for that store.
  // We forward those fields verbatim so the install prompt and home-screen
  // icon use the per-tenant branding instead of the generic defaults below.
  const apiManifest = await fetchStoreManifest(store.id);

  if (apiManifest) {
    // Under `ar` the API's Arabic members win (#2194), then the API's own
    // (English) value, then the localized store name (#2195) — so a merchant
    // who typed an Arabic app name gets it, and one who did not still never
    // gets a half-localized install prompt from the fallback.
    const isAr = locale === 'ar';
    return {
      name: (isAr && apiManifest.name_ar) || apiManifest.name || localizedStoreName,
      short_name:
        (isAr && apiManifest.short_name_ar) || apiManifest.short_name || localizedStoreName,
      description:
        (isAr && apiManifest.description_ar) ||
        (isAr ? localizedStoreDescriptionFallback : apiManifest.description) ||
        localizedStoreDescriptionFallback,
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
    // Localized like the description below (#2195): an Arabic storefront's
    // home-screen caption must not read English next to an Arabic description.
    name: localizedStoreName,
    short_name: localizedStoreName,
    description: pickMetaDescription(store, locale) || localizedStoreDescriptionFallback,
    start_url: '/',
    display: 'standalone',
    // The platform-default store (no real merchant resolved) is Ebda itself:
    // night chrome + the open-door icons incl. maskable. Real merchants keep
    // their own colours and icons.
    background_color: isPlatformDefault ? BRAND.colors.night : '#ffffff',
    theme_color: isPlatformDefault ? BRAND.colors.night : fallbackThemeColor,
    icons: [
      ...(store.favicon
        ? [
            { src: store.favicon, sizes: '192x192', type: 'image/png' },
            { src: store.favicon, sizes: '512x512', type: 'image/png' },
          ]
        : [
            { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
            { src: '/icon-512.png', sizes: '512x512', type: 'image/png' },
            ...(isPlatformDefault
              ? [
                  {
                    src: '/icon-maskable-192.png',
                    sizes: '192x192',
                    type: 'image/png',
                    purpose: 'maskable' as const,
                  },
                  {
                    src: '/icon-maskable-512.png',
                    sizes: '512x512',
                    type: 'image/png',
                    purpose: 'maskable' as const,
                  },
                ]
              : []),
          ]),
    ],
  };
}
