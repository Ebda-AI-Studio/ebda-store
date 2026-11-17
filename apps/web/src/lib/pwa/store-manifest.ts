import type { MetadataRoute } from 'next';
import { getStore } from '../store-resolver';
import { API_URL } from '../api';
import { pickMetaDescription } from '../seo/meta-description';
import { resolveStorefrontLocale } from '../seo/resolve-locale';
import { isStorefrontPwaActive } from './pwa-active';
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
 * Try to fetch the PWA settings the merchant SAVED, as the API emits them: only saved members, nothing filled in
 * (Ruling PWA-MANIFEST-1). A store that never saved any answers `{}`. Returns `null` when the plan has no PWA, the
 * store id is unknown (demo fallback), the fetch fails or times out, or the answer fails `storePwaManifestSchema`.
 * The caller then serves the generic manifest built from the store's own fields, so a broken merchant manifest is
 * never worse than no merchant manifest.
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

type ResolvedStore = Awaited<ReturnType<typeof getStore>>;
type Locale = 'en' | 'ar';

/**
 * The home-screen caption: platforms cut it at about 12 characters, so a longer store name becomes its
 * first word when that fits, else its first 12 characters. A merchant's saved short name always wins.
 */
function homeScreenName(name: string): string {
  const n = name.trim();
  if ([...n].length <= 12) return n;
  const first = n.split(/\s+/)[0] ?? n;
  return [...first].length <= 12 ? first : [...n].slice(0, 12).join('').trim();
}

/** The store's Arabic name, when it has one. */
const arabicStoreName = (store: ResolvedStore) => store.nameAr?.trim() || undefined;

/**
 * The manifest built from the store's own fields alone. It is the WHOLE manifest of a store that saved no PWA
 * settings, and the fallback for every member a merchant left unsaved (`withSavedSettings`): one builder, so the two
 * can never drift apart.
 */
function genericManifest(store: ResolvedStore, locale: Locale): MetadataRoute.Manifest {
  const primaryColor = store.theme?.primaryColor || BRAND.colors.gold;
  const fallbackThemeColor = hslToHex(primaryColor);
  // `DEFAULT_STORE` sentinel (store-resolver.ts): no merchant resolved → platform.
  const isPlatformDefault = store.id === 'demo' && !store.favicon;
  const merchantIcon = store.favicon || (store.id === 'demo' ? undefined : store.logo) || undefined;
  // Arabic locale reads the merchant's Arabic name when present (issue
  // #1857) — else this fallback description interpolates the English name
  // under `<html lang="ar">`.
  const localizedStoreName = locale === 'ar' ? arabicStoreName(store) || store.name : store.name;
  const localizedStoreDescriptionFallback =
    locale === 'ar' ? `تسوق في ${localizedStoreName}` : `Shop at ${localizedStoreName}`;

  return {
    // Localized like the description below (#2195): an Arabic storefront's
    // home-screen caption must not read English next to an Arabic description.
    name: localizedStoreName,
    short_name: homeScreenName(localizedStoreName),
    description: pickMetaDescription(store, locale) || localizedStoreDescriptionFallback,
    start_url: '/',
    display: 'standalone',
    // The platform-default store (no real merchant resolved) is Ebda itself:
    // night chrome + the open-door icons incl. maskable. Real merchants keep
    // their own colours and icons.
    background_color: isPlatformDefault ? BRAND.colors.night : '#ffffff',
    theme_color: isPlatformDefault ? BRAND.colors.night : fallbackThemeColor,
    // PW2: the merchant's own picture first (favicon, else logo), the platform icons only when they set none.
    icons: [
      ...(merchantIcon
        ? [
            { src: merchantIcon, sizes: '192x192', type: 'image/png' },
            { src: merchantIcon, sizes: '512x512', type: 'image/png' },
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

/**
 * The generic manifest with each member the merchant SAVED laid over it. A saved member wins; a member that was never
 * saved keeps exactly the generic value, so `saved = {}` returns the generic manifest unchanged.
 *
 * Under `ar` (#2194, #2195) the order for the two names is: the saved Arabic member, then the store's own Arabic name
 * (the generic value), and only for a store with no Arabic name the saved English member. The description never
 * crosses languages: under `ar` it is the saved Arabic description or the generic one, never the saved English text.
 */
function withSavedSettings(
  generic: MetadataRoute.Manifest,
  saved: ApiManifest,
  locale: Locale,
  storeHasArabicName: boolean
): MetadataRoute.Manifest {
  const isAr = locale === 'ar';
  const savedEnglish = (value: string | undefined) =>
    isAr && storeHasArabicName ? undefined : value;
  return {
    ...generic,
    name: (isAr && saved.name_ar) || savedEnglish(saved.name) || generic.name,
    short_name:
      (isAr && saved.short_name_ar) || savedEnglish(saved.short_name) || generic.short_name,
    description: (isAr ? saved.description_ar : saved.description) || generic.description,
    start_url: saved.start_url || generic.start_url,
    display: saved.display || generic.display,
    background_color: saved.background_color || generic.background_color,
    theme_color: saved.theme_color || generic.theme_color,
    // The generic manifest names neither of these two, so they exist only when saved.
    ...(saved.orientation ? { orientation: saved.orientation } : {}),
    ...(saved.scope ? { scope: saved.scope } : {}),
    icons: saved.icons && saved.icons.length > 0 ? saved.icons.map(normalizeIcon) : generic.icons,
  };
}

/**
 * The store's web app manifest, in the language of the request (Ruling PWA-MANIFEST-2).
 *
 * This is NOT `app/manifest.ts`: a file-based manifest at the app root always wins over the `manifest` a layout
 * names in its metadata, so every page would link the one shared URL. A browser fetches a manifest without
 * cookies, so that one URL can only ever answer in the store's default language. The route handler
 * `app/manifest.webmanifest/route.ts` serves this instead, and the root layout links `/<lang>/manifest.webmanifest`
 * from a `/ar` or `/en` page; the middleware carries that language here as `x-locale-path`, which
 * `resolveStorefrontLocale` reads first.
 */
export async function buildStoreManifest(): Promise<MetadataRoute.Manifest | null> {
  const store = await getStore();
  // PW1: a store whose phone-app switch is off has no manifest at all, so nothing can install it.
  if (!isStorefrontPwaActive(store)) return null;
  const storeDefaultLanguage = (store.settings as Record<string, unknown> | undefined)
    ?.defaultLanguage as string | undefined;
  const locale = await resolveStorefrontLocale(storeDefaultLanguage);
  const generic = genericManifest(store, locale);

  // What the merchant saved in the admin PWA tab (app name, colours, icons...), and nothing else: the API fills in no
  // default, so every member it leaves out keeps the generic value above.
  const saved = await fetchStoreManifest(store.id);
  return saved
    ? withSavedSettings(generic, saved, locale, Boolean(arabicStoreName(store)))
    : generic;
}
