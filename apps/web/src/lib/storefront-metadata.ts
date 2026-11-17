import type { Metadata } from 'next';
import type { ResolvedStore } from './store-resolver';
import { getSiteUrl, storeAbsoluteUrl } from './structured-data';
import { pickMetaDescription } from './seo/meta-description';
import { resolveStoreOgImage } from './seo/og-image';
import { hidesFromSearch } from './hide-from-search';

/**
 * Storefront `<head>` metadata builder — extracted 2026-07-12 from
 * `app/layout.tsx`'s `generateMetadata` (verbatim logic move, zero behavior
 * change) so BOTH the legacy header-based root layout AND the new
 * params-based `app/tenant-store/[tenant]/[locale]/layout.tsx` (tenant-cacheable
 * routing, dark-launched behind `STOREFRONT_TENANT_ROUTING`) emit identical
 * metadata without duplicating this ~200-line builder. See
 * docs/plans/done/2026-07-12-tenant-cacheable-routing.md §3.6.
 *
 * The ONLY thing that differs between callers is how `isOnCustomDomain` is
 * determined (the legacy layout reads the `host` header; the new layout
 * reads the `[tenant]` route param) — that detection stays with each
 * caller and is passed in already-resolved.
 */
export function buildStorefrontMetadata(
  store: ResolvedStore,
  isOnCustomDomain: boolean,
  /**
   * The request's resolved locale — the SAME value that picked `<html lang>`
   * (#1856). Callers pass `resolveStorefrontLocale()` (legacy tree) or
   * `localeFromRouteParam()` (tenant tree). Omitted → the store default,
   * the previous behaviour.
   */
  locale?: 'en' | 'ar'
): Metadata {
  const siteUrl = getSiteUrl(store);

  // Honour the admin's `defaultLanguage` setting when picking which SEO copy
  // to surface. The arabic meta fields existed in the resolver and admin form
  // for months but nothing actually read them — same bug class as the
  // footerLinks audit. Fall back to the english variant whenever the arabic
  // one is empty so partially-translated stores degrade gracefully.
  const defaultLanguage = (store.settings as Record<string, unknown>)?.defaultLanguage as
    | 'en'
    | 'ar'
    | undefined;
  // The cookie-aware request locale wins, so the root <meta name="description">
  // / og:locale can no longer disagree with the page's own <html lang> (#1856).
  const preferAr = (locale ?? defaultLanguage) === 'ar';
  const localizedTitle = preferAr ? store.metaTitleAr || store.metaTitle : store.metaTitle;
  const localizedDescription = pickMetaDescription(store, preferAr ? 'ar' : 'en');
  const localizedStoreName = preferAr && store.nameAr ? store.nameAr : store.name;

  // Default OG/meta description when the merchant set no SEO description and no
  // store description. Kept generic + truthful — do NOT bake a shipping promise
  // ("free delivery over 20 EGP") into the platform default: that claim isn't
  // true for every store and surfaced on stores that never offered it.
  const description =
    localizedDescription ||
    (preferAr
      ? `تسوق أونلاين من ${localizedStoreName} في مصر: تصفّح المنتجات واطلب بسهولة من موبايلك.`
      : `Shop ${localizedStoreName} online in Egypt: browse the full catalogue and order in a few taps from your phone.`);

  const titleDefault =
    localizedTitle ||
    (preferAr
      ? `${localizedStoreName} - تسوق أونلاين في مصر`
      : `${localizedStoreName} - Online Shopping in Egypt`);

  // Resolve the og:image entry: use the merchant's explicit raster ogImage when
  // set, else the store-aware `/og?slug=<slug>` card (renders the store's logo
  // or name). The slug is REQUIRED for path-based storefronts — without it the
  // card resolves to the platform-default "Force" store. See og-image.ts.
  const ogImageEntry = resolveStoreOgImage(store.ogImage, siteUrl, localizedStoreName, store.slug);

  // Normalize Twitter handle to leading-@ form expected by Twitter card meta.
  const twitterHandle = store.twitterHandle
    ? store.twitterHandle.startsWith('@')
      ? store.twitterHandle
      : `@${store.twitterHandle}`
    : undefined;

  // PWA-driven Apple meta. The admin's PWA settings page lets owners override
  // the install title, status-bar style, and maskable icon — but until now the
  // storefront ignored them and emitted nothing. Build an apple-specific block
  // when the feature is on, keyed off pwaSettings so iOS devices get the right
  // status bar tint, the right home-screen title, and a real touch icon.
  const pwa = (store.pwaSettings as Record<string, unknown> | undefined) || undefined;
  const pwaIosStatusBar =
    typeof pwa?.iosStatusBarStyle === 'string'
      ? (pwa.iosStatusBarStyle as 'default' | 'black' | 'black-translucent')
      : undefined;
  // B5 (2026-05-04 plan, task 5): a real 180x180 apple-touch-icon, generated
  // server-side alongside the rest of the icon set, beats every fallback
  // below — but ONLY when the merchant has actually uploaded one. Every
  // store that hasn't (all 3 live storefronts today) falls through the
  // EXACT SAME chain this already was, byte-for-byte, so nothing changes
  // for them until they upload a new icon via the admin.
  const pwaAppleTouchIcon =
    typeof pwa?.iconAppleTouch === 'string' && pwa.iconAppleTouch
      ? (pwa.iconAppleTouch as string)
      : undefined;
  const pwaTouchIcon =
    pwaAppleTouchIcon ||
    (typeof pwa?.maskableIcon === 'string' && pwa.maskableIcon
      ? (pwa.maskableIcon as string)
      : typeof pwa?.icon512 === 'string' && pwa.icon512
        ? (pwa.icon512 as string)
        : typeof pwa?.icon192 === 'string' && pwa.icon192
          ? (pwa.icon192 as string)
          : store.favicon || undefined);
  // Same B5 task: real 32x32 / 16x16 browser-tab favicons, generated from
  // the same source upload. Falls back to the pre-existing favicon/logo
  // chain (single entry, no `sizes`) when neither is set — see iconsBlock.
  const pwaFavicon32 =
    typeof pwa?.favicon32 === 'string' && pwa.favicon32 ? (pwa.favicon32 as string) : undefined;
  const pwaFavicon16 =
    typeof pwa?.favicon16 === 'string' && pwa.favicon16 ? (pwa.favicon16 as string) : undefined;
  const pwaAppTitle =
    typeof pwa?.shortName === 'string' && pwa.shortName
      ? (pwa.shortName as string)
      : typeof pwa?.appName === 'string' && pwa.appName
        ? (pwa.appName as string)
        : localizedStoreName;
  // PWA is "active" only when BOTH the store-level toggle AND the
  // platform feature flag are on. Without the platform-flag gate the
  // service worker registered + apple-touch-icon was emitted even when
  // super_admin had disabled the pwa feature for the store, so the
  // flag was effectively cosmetic.
  const pwaActive = store.pwaEnabled === true && (store.enabledFeatures?.includes('pwa') ?? true);

  // Build the icons block: regular favicon + (when pwa is on) apple-touch-icon
  // so installing-to-home-screen on iOS uses the store's branding rather than
  // a screenshot of the page chrome.
  const iconsBlock: NonNullable<Metadata['icons']> | undefined = (() => {
    const icons: NonNullable<Metadata['icons']> = {};
    // Favicon: prefer the generated 32x32/16x16 pair (real browser-tab
    // favicons) when the merchant has uploaded a PWA icon set; otherwise
    // fall back to the merchant's custom favicon, else the store's own logo
    // so browser tabs + link-preview (WhatsApp) show the STORE's brand — not
    // the platform's default Ebda icon when no favicon was uploaded.
    // This is the EXACT pre-B5 fallback for any store without favicon32/16.
    const faviconSrc = store.favicon || store.logo || undefined;
    if (pwaActive && (pwaFavicon32 || pwaFavicon16)) {
      icons.icon = [
        ...(pwaFavicon32 ? [{ url: pwaFavicon32, sizes: '32x32', type: 'image/png' }] : []),
        ...(pwaFavicon16 ? [{ url: pwaFavicon16, sizes: '16x16', type: 'image/png' }] : []),
      ];
    } else if (faviconSrc) {
      icons.icon = faviconSrc;
    }
    if (pwaActive && pwaTouchIcon) icons.apple = pwaTouchIcon;
    return icons.icon || icons.apple ? icons : undefined;
  })();

  return {
    // og:image (the file-based opengraph-image route) resolves against
    // metadataBase. NEXT_PUBLIC_SITE_URL forces siteUrl to the platform domain
    // for EVERY store, so og:image pointed at ebda.app/opengraph-image
    // — where the path-slug middleware serves HTML, not the image (broken WhatsApp
    // preview). Anchor metadataBase to the store's OWN domain when it has one so
    // the OG image resolves on the domain the page is actually served from.
    metadataBase: new URL(store.domain ? `https://${store.domain}` : siteUrl),
    title: {
      default: titleDefault,
      template: `%s | ${localizedStoreName}`,
    },
    description,
    // NO `alternates.canonical` here on purpose. This function backs the
    // ROOT layout's `generateMetadata` (both the legacy header-based layout
    // AND the tenant-store `[locale]` layout) — its return value is the
    // FALLBACK metadata for every route under it, and Next.js fills in any
    // top-level key (like `alternates`) a page doesn't set itself from the
    // nearest ancestor that does. Setting a canonical here once pointed
    // EVERY page with no canonical of its own (privacy, terms, about, faq,
    // contact, cart, checkout, account/*, ...) at the STORE HOME instead of
    // having none — verified live: `/privacy` picked up
    // `<link rel="canonical" href="https://demo-store.example">`, telling
    // crawlers the privacy policy is a duplicate of the homepage. The home
    // canonical (A3, 2026-09-22 AEO audit) is set at the actual home ROUTE
    // instead — `app/page.tsx` and `app/tenant-store/[tenant]/[locale]/page.tsx`
    // each carry their own `generateMetadata` for exactly this reason.
    keywords: [
      'e-commerce',
      'online store',
      'shopping',
      'Egypt',
      'EGP',
      'delivery',
      localizedStoreName,
    ],
    authors: [{ name: localizedStoreName }],
    creator: localizedStoreName,
    publisher: localizedStoreName,
    formatDetection: {
      email: false,
      address: false,
      telephone: false,
    },
    openGraph: {
      type: 'website',
      // Facebook/WhatsApp Open Graph locales: Egypt for Arabic, US English (en_EG is not a valid FB locale).
      locale: preferAr ? 'ar_EG' : 'en_US',
      alternateLocale: preferAr ? 'en_US' : 'ar_EG',
      siteName: localizedStoreName,
      title: titleDefault,
      description,
      // Store-home canonical URL (the default og:url before a page-level
      // override replaces this whole openGraph object) — must carry the
      // platform `/<slug>` prefix for stores with no custom domain, same as
      // every other per-page canonical/JSON-LD `url` builder.
      url: storeAbsoluteUrl(store, ''),
      // Always include an og:image with explicit dimensions.
      // WhatsApp requires og:image to be an ABSOLUTE https URL with
      // og:image:width + og:image:height — without dimensions WhatsApp
      // falls back to a thumbnail scrape that produces a blank card.
      images: [ogImageEntry],
    },
    twitter: {
      card: 'summary_large_image',
      title: titleDefault,
      description,
      // Twitter card image — use the same absolute URL as og:image.
      images: [ogImageEntry.url],
      ...(twitterHandle ? { site: twitterHandle, creator: twitterHandle } : {}),
    },
    robots:
      // The demo showroom is never indexed (Ruling B1-14): it is a preview of looks, not a shop.
      // A store the merchant hid from search engines (`hideFromSearchEngines`) is noindex on every page while they
      // prepare it; cart and checkout still render (this is not maintenance).
      store.status === 'suspended' || store.isDemo || hidesFromSearch(store)
        ? {
            // Suspended stores render the branded maintenance page on every
            // route — explicitly tell crawlers not to index that as the
            // store's canonical content so the merchant doesn't lose SEO
            // when they come back online.
            index: false,
            follow: false,
          }
        : {
            index: true,
            follow: true,
          },
    icons: iconsBlock,
    ...(pwaActive
      ? {
          // Tells iOS Safari that the page can be installed as a standalone
          // web app and to use the configured status-bar tint + home-screen
          // title instead of falling back to the document title.
          appleWebApp: {
            capable: true,
            title: pwaAppTitle,
            statusBarStyle: pwaIosStatusBar || 'default',
          },
        }
      : {}),
    // Google Search Console verification. Two layers:
    //   - Platform token (`gzm3VDX...`) verifies the platform domain
    //     `ebda.app`. Applies on the platform path
    //     (<slug>.ebda.app) only.
    //   - Per-store token (`Store.googleSiteVerification`) verifies the
    //     merchant's own custom domain. Applies only when the request
    //     is being served for that custom domain.
    // The two domains have DIFFERENT GSC accounts that don't share
    // ownership — emitting the wrong token on the wrong host breaks
    // verification AND leaks the hosting relationship. Host-aware
    // selection below: customer-facing domain ⇒ per-store only; platform
    // path ⇒ platform + per-store (if set).
    verification: {
      google: isOnCustomDomain
        ? (store.googleSiteVerification ?? undefined)
        : store.googleSiteVerification
          ? ['gzm3VDXL0OakVx_Rf4ytQZSyWZeW4nHg0WLcvxsehVI', store.googleSiteVerification]
          : 'gzm3VDXL0OakVx_Rf4ytQZSyWZeW4nHg0WLcvxsehVI',
    },
  };
}
