import type { Metadata, Viewport } from 'next';
import { Suspense } from 'react';
import { cookies, headers } from 'next/headers';
import { Plus_Jakarta_Sans, IBM_Plex_Sans_Arabic } from 'next/font/google';
import { ToastProvider } from '@force/ui';
import { LanguageProvider } from '../contexts/LanguageContext';
import { StoreProvider } from '../contexts/StoreContext';
import { CartProvider } from '../contexts/CartContext';
import { AuthProvider } from '../contexts/AuthContext';
import { FeatureProvider } from '../contexts/FeatureContext';
import { getStore } from '../lib/store-resolver';
import { API_URL } from '../lib/api';
import { organizationJsonLd, getSiteUrl } from '../lib/structured-data';
import { pickMetaDescription } from '../lib/seo/meta-description';
import { resolveStoreOgImage } from '../lib/seo/og-image';
import { MarketingPixelsProvider } from '../components/MarketingPixels';
import { PostHogProvider } from '../components/PostHogProvider';
import { ServiceWorkerRegistration } from '../components/ServiceWorkerRegistration';
import { ScrollToTop } from '../components/ScrollToTop';
import { PushNotificationPrompt } from '../components/PushNotificationPrompt';
import { OneSignalStorefrontInit } from '../components/OneSignalStorefrontInit';
import { TypographyProbe } from '../components/TypographyProbe';
import { AffiliateTracker } from '../components/AffiliateTracker';
import { StoreMaintenance } from '../components/StoreMaintenance';
import { ConsentProvider, type ConsentState } from '../contexts/ConsentContext';
import { CookieConsentBanner } from '../components/CookieConsentBanner';
import { CookiePreferencesModal } from '../components/CookiePreferencesModal';
import { CookiePreferencesLink } from '../components/CookiePreferencesLink';
import { type MarketingPixels, themeToCssVars } from '@force/shared';
import '../styles/globals.css';

/**
 * Sanitize a theme color value to prevent CSS injection.
 *
 * Theme colors from the database are HSL component strings (e.g. "26 100% 50%")
 * or hex colors (e.g. "#ff6e00"). This function validates the value matches one
 * of those safe formats and strips any dangerous CSS content that could escape
 * the declaration context.
 *
 * Returns `fallback` if the value does not pass validation.
 */
function sanitizeThemeColor(value: string, fallback = '0 0% 0%'): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 50) {
    return fallback;
  }

  // Block dangerous CSS constructs that could break out of a declaration
  const dangerous = /[{}]|url\s*\(|@import|expression\s*\(|javascript\s*:/i;
  if (dangerous.test(value)) {
    return fallback;
  }

  // Hex color: #RGB, #RRGGBB, or #RRGGBBAA (3-8 hex digits)
  const hexPattern = /^#[0-9a-fA-F]{3,8}$/;
  if (hexPattern.test(value)) {
    return value;
  }

  // HSL components: e.g. "26 100% 50%", "0 0% 100%", "220 14% 96%"
  // Allows optional decimal points and the slash syntax for alpha (e.g. "26 100% 50% / 0.5")
  const hslPattern =
    /^[0-9]+(?:\.[0-9]+)?\s+[0-9]+(?:\.[0-9]+)?%\s+[0-9]+(?:\.[0-9]+)?%(?:\s*\/\s*[0-9]+(?:\.[0-9]+)?%?)?$/;
  if (hslPattern.test(value)) {
    return value;
  }

  return fallback;
}

/**
 * Sanitize a non-color CSS custom property value (e.g. --radius, --font-family).
 * Allows rem/px units, var() references, and simple keyword values.
 */
function sanitizeCssValue(value: string, fallback = '0'): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 100) {
    return fallback;
  }
  const dangerous = /[{}]|url\s*\(|@import|expression\s*\(|javascript\s*:/i;
  if (dangerous.test(value)) {
    return fallback;
  }
  // Allow: digits, letters, spaces, %, #, dots, parens (for var()), slashes, hyphens, commas
  const allowed = /^[a-zA-Z0-9\s%#.,()\/\-]+$/;
  if (!allowed.test(value)) {
    return fallback;
  }
  return value;
}

const plusJakarta = Plus_Jakarta_Sans({
  subsets: ['latin'],
  variable: '--font-sans',
  display: 'swap',
  weight: ['400', '500', '600', '700', '800'],
});

const ibmPlexArabic = IBM_Plex_Sans_Arabic({
  subsets: ['arabic'],
  variable: '--font-arabic',
  display: 'swap',
  weight: ['400', '500', '600', '700'],
});

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 5,
  // viewport-fit=cover so iPhone safe-area-inset env vars resolve to
  // real pixel values; lets a future bottom utility / floating add-to-cart
  // bar sit above the home indicator instead of overlapping it.
  viewportFit: 'cover',
  themeColor: '#ff6e00',
};

export async function generateMetadata(): Promise<Metadata> {
  const store = await getStore();
  const siteUrl = getSiteUrl(store);

  // Detect whether we're rendering for the merchant's custom domain
  // (wadyaljuz.com) vs the platform path (store.forcemediakw.com/<slug>).
  // The signal is the request host header. When on the custom domain,
  // GSC verification needs the merchant's own token — emitting the
  // platform token alongside breaks verification (GSC reads only the
  // first meta tag) AND leaks "this site is hosted by Force" to crawlers
  // that scan the meta tags. On the platform path, the platform token
  // owns the domain and is what GSC verifies against.
  const requestHost = (await headers()).get('host')?.toLowerCase() ?? '';
  const isOnCustomDomain = !!(store.domain && requestHost === store.domain.toLowerCase());

  // Honour the admin's `defaultLanguage` setting when picking which SEO copy
  // to surface. The arabic meta fields existed in the resolver and admin form
  // for months but nothing actually read them — same bug class as the
  // footerLinks audit. Fall back to the english variant whenever the arabic
  // one is empty so partially-translated stores degrade gracefully.
  const defaultLanguage = (store.settings as Record<string, unknown>)?.defaultLanguage as
    | 'en'
    | 'ar'
    | undefined;
  const preferAr = defaultLanguage === 'ar';
  const localizedTitle = preferAr ? store.metaTitleAr || store.metaTitle : store.metaTitle;
  const localizedDescription = pickMetaDescription(store, preferAr ? 'ar' : 'en');
  const localizedStoreName = preferAr && store.nameAr ? store.nameAr : store.name;

  const description =
    localizedDescription ||
    (preferAr
      ? `تسوق أونلاين من ${localizedStoreName}. توصيل مجاني للطلبات فوق 20 د.ك.`
      : `Shop online at ${localizedStoreName}. Free delivery on orders over 20 KWD.`);

  const titleDefault =
    localizedTitle ||
    (preferAr
      ? `${localizedStoreName} - تسوق أونلاين في الكويت`
      : `${localizedStoreName} - Online Shopping in Kuwait`);

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
  const pwaTouchIcon =
    typeof pwa?.maskableIcon === 'string' && pwa.maskableIcon
      ? (pwa.maskableIcon as string)
      : typeof pwa?.icon512 === 'string' && pwa.icon512
        ? (pwa.icon512 as string)
        : typeof pwa?.icon192 === 'string' && pwa.icon192
          ? (pwa.icon192 as string)
          : store.favicon || undefined;
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
    if (store.favicon) icons.icon = store.favicon;
    if (pwaActive && pwaTouchIcon) icons.apple = pwaTouchIcon;
    return icons.icon || icons.apple ? icons : undefined;
  })();

  return {
    // og:image (the file-based opengraph-image route) resolves against
    // metadataBase. NEXT_PUBLIC_SITE_URL forces siteUrl to the platform domain
    // for EVERY store, so og:image pointed at store.forcemediakw.com/opengraph-image
    // — where the path-slug middleware serves HTML, not the image (broken WhatsApp
    // preview). Anchor metadataBase to the store's OWN domain when it has one so
    // the OG image resolves on the domain the page is actually served from.
    metadataBase: new URL(store.domain ? `https://${store.domain}` : siteUrl),
    title: {
      default: titleDefault,
      template: `%s | ${localizedStoreName}`,
    },
    description,
    keywords: [
      'e-commerce',
      'online store',
      'shopping',
      'Kuwait',
      'KWD',
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
      locale: preferAr ? 'ar_KW' : 'en_KW',
      alternateLocale: preferAr ? 'en_KW' : 'ar_KW',
      siteName: localizedStoreName,
      title: titleDefault,
      description,
      url: siteUrl,
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
      store.status === 'suspended'
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
    //     `store.forcemediakw.com`. Applies on the platform path
    //     (store.forcemediakw.com/<slug>) only.
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

/**
 * Preview-draft fetcher 2026-05-21 — when the middleware has set the
 * force-preview-draft cookie (because the iframe loaded with ?_layoutDraft=
 * at any point in the past hour), fetch the draft bundle from the API and
 * return its typography + theme. Used to override the committed-store
 * values for the typography CSS emitter so EVERY page in the iframe
 * (not just the homepage) reflects the merchant's pending changes.
 *
 * Returns nulls when the cookie is missing, the token has expired in
 * Redis, or the fetch fails. Callers fall back to committed store data
 * in that case.
 */
async function fetchDraftBundleForCurrentRequest(
  storeId: string | undefined,
  draftToken: string | undefined,
  apiUrl: string
): Promise<{ typography: unknown; theme: unknown } | null> {
  if (!storeId || !draftToken) return null;
  try {
    const res = await fetch(
      `${apiUrl}/public/stores/${storeId}/layout?_layoutDraft=${encodeURIComponent(draftToken)}`,
      { cache: 'no-store' }
    );
    if (!res.ok) return null;
    const json = await res.json();
    const data = json?.data;
    if (!data?.isDraft) return null;
    return { typography: data.typography, theme: data.theme };
  } catch {
    return null;
  }
}

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // Fetch store data server-side
  const store = await getStore();

  // Resolve language server-side: cookie wins, store default is the fallback.
  // Before this lived in localStorage only — server-rendered chrome (titles,
  // breadcrumbs, meta tags, schema.org) always used the store default
  // regardless of the user's toggle, so EN visitors on an AR-default store
  // saw mixed content. The cookie is set client-side in LanguageContext on
  // every setLanguage() call.
  const cookieStore = await cookies();
  const cookieLang = cookieStore.get('force-language')?.value as 'en' | 'ar' | undefined;
  // Preview-draft propagation (set by middleware). Header wins for FIRST
  // load with ?_layoutDraft= in the URL (cookies set in the response
  // aren't visible to the same response's server components). Cookie
  // fallback covers subsequent navigations within the iframe.
  const headersList = await headers();
  const draftToken =
    headersList.get('x-preview-draft') ?? cookieStore.get('force-preview-draft')?.value;
  // API_URL already includes the /api/v1 prefix (see lib/api.ts); the helper
  // appends the route path directly to avoid a doubled /api/v1/api/v1/ 404.
  const draftBundle = await fetchDraftBundleForCurrentRequest(store.id, draftToken, API_URL);
  const storeDefaultLanguage = (store.settings as Record<string, unknown>)?.defaultLanguage as
    | 'en'
    | 'ar'
    | undefined;
  const resolvedLanguage: 'en' | 'ar' =
    cookieLang === 'ar' || cookieLang === 'en'
      ? cookieLang
      : storeDefaultLanguage === 'ar'
        ? 'ar'
        : 'en';
  const lang = resolvedLanguage;
  const dir = resolvedLanguage === 'ar' ? 'rtl' : 'ltr';

  // Cookie consent — read server-side so MarketingPixelsProvider is only
  // RENDERED into the HTML when the user has consented to marketing.
  // GDPR Art. 6(a) + ePrivacy + Kuwait Law 13/2023 require prior consent
  // BEFORE non-essential tracking scripts execute. Client-side gating
  // alone leaks the script on first paint; SSR gating prevents that.
  const consentCookieRaw = cookieStore.get('force-cookie-consent')?.value;
  let resolvedConsent: ConsentState | null = null;
  if (consentCookieRaw) {
    try {
      const parsed = JSON.parse(decodeURIComponent(consentCookieRaw)) as ConsentState;
      if (parsed && typeof parsed.marketing === 'boolean' && parsed.v === 1) {
        resolvedConsent = parsed;
      }
    } catch {
      // Malformed cookie — treat as no consent (banner shows again).
    }
  }
  const marketingConsentGranted = resolvedConsent?.marketing === true;

  // Organization JSON-LD for search engines
  const orgJsonLd = organizationJsonLd(store);

  // Build a <style> tag that overrides the default orange theme in globals.css
  // Inline styles on <html> don't beat `:root {}` in @layer base, so we inject a :root rule instead
  const themeCssVars = store.theme ? themeToCssVars(store.theme) : null;
  // Non-color CSS custom properties that use sanitizeCssValue instead of sanitizeThemeColor
  const nonColorVars = new Set(['--radius', '--font-family']);

  const themeStyleTag = themeCssVars
    ? `:root { ${Object.entries(themeCssVars)
        .map(([k, v]) => {
          const sanitized = nonColorVars.has(k) ? sanitizeCssValue(v) : sanitizeThemeColor(v);
          return `${k}: ${sanitized}`;
        })
        .join('; ')} }`
    : '';

  // Build the per-store typography style tags (custom-font @font-face,
  // Google Fonts <link>, and per-zone CSS rules targeting
  // `[data-zone="..."]` containers in every template). The shape is
  // validated by Zod on PUT, but we still sanitize each output value
  // because the storefront ultimately injects this into a <style> tag.
  const ZONE_NAMES = [
    // Broad zones — keep listed FIRST so their CSS rules emit first
    // and the sub-zone rules below them win cascade ties.
    'beforeHeader',
    'header',
    // storeName is a sub-zone of header — the store name text element inside
    // every theme Header. Listed after header so a tied selector still wins
    // on source order. Closes wiring gap from 2026-05-20 audit.
    'storeName',
    'categories',
    'products',
    'footer',
    'afterFooter',
    // Sub-zones — nested inside the broad ones; emitted last so a
    // tied selector still wins on source order, on top of having
    // (usually) the same specificity. Section heading sub-zones
    // (sectionKicker / sectionTitle / sectionSubtitle / sectionSeeAll)
    // tag the 4 individual elements inside SectionHeading so a chip /
    // underline on the title doesn't bleed onto the "View All" link.
    'sectionKicker',
    'sectionTitle',
    'sectionSubtitle',
    'sectionSeeAll',
    'productName',
    'productPrice',
    'cta',
    'filters',
  ] as const;
  const sanitizeFontValue = (v: unknown): string | null => {
    if (typeof v !== 'string' || v.length === 0 || v.length > 200) return null;
    if (/[{}]|url\s*\(|@import|expression\s*\(|javascript\s*:|<|>/i.test(v)) return null;
    return v;
  };
  // Translate brand-color preset tokens to CSS that resolves against the
  // store's theme CSS variables. Each var() ships with a HSL-component
  // fallback so the chip renders SOMETHING when the store hasn't
  // customised that color slot. Without the fallback, an undefined
  // `--primary` would emit `hsl()` (invalid) and the browser would
  // silently drop the whole `background-color` declaration — the
  // merchant would see no colour on the chip even after saving.
  // Fallback HSL values mirror @force/ui's default theme palette.
  //
  // SMART CONTEXT (Ahmad 2026-05-16): some brand tokens are BACKGROUND-
  // semantic (brand-muted, brand-background) — using them as text colour
  // makes the text disappear on default-color pages (white on white).
  // When the merchant picks one of these for a text field, auto-flip to
  // a readable variant (--muted-foreground / --foreground). Same flip
  // in reverse for brand-foreground when used as background (text-color
  // on text-color background = invisible). Background fields use the
  // raw value as-is — that's the merchant's explicit choice.
  type ColorFieldContext = 'text' | 'background';
  const resolveColorValue = (v: string, context: ColorFieldContext = 'background'): string => {
    // Generic 'token:<name>' handler — covers every entry in COLOR_TOKENS
    // (primary/secondary/accent/card/muted/foreground/border). Fall back to
    // the global CSS variable so the resolution works even when Store.theme
    // doesn't carry the matching `*Color` field (e.g. card/muted/border are
    // newer tokens not present on legacy theme rows).
    //
    // Verified 2026-05-20 — wadyaljuz had merchant picked `token:card` for
    // the footer color zone, but the old switch-style handler below only
    // knew primary/secondary/accent, so the literal string "token:card" was
    // emitted as a CSS value and the browser silently dropped the rule.
    if (v.startsWith('token:')) {
      const key = v.slice('token:'.length);
      // 2026-05-20 night: NO "smart" readability flips. Honor merchant intent
      // exactly. ColorField in admin already shows a contrast preview against
      // the store's background, so the merchant has feedback at the point of
      // pick. Auto-flipping `token:card` (bg token) when used as TEXT was
      // wrong — a merchant who saved a dark footer bg + picked `card` for
      // the text was deliberately choosing white text on the dark surface.
      // The flip rewrote it to `--foreground` (dark) → dark-on-dark
      // invisible. Verified on Wady Aljuz footer.
      //
      // Reference: feedback-self-suppressing-convenience-gate (global). The
      // merchant's explicit toggle/pick beats any platform "designer
      // preference" auto-correct.
      //
      // Identifier-only allowlist to keep CSS-injection surface zero.
      if (/^[a-zA-Z][a-zA-Z0-9-]{0,32}$/.test(key)) {
        return `hsl(var(--${key}))`;
      }
      return 'inherit';
    }
    // Legacy 'brand-*' format — kept for stores saved before the token:
    // refactor. Falls into the same readability flips as token: above.
    if (v === 'brand-primary') return 'hsl(var(--primary, 220 13% 18%))';
    if (v === 'brand-secondary') return 'hsl(var(--secondary, 220 14% 96%))';
    if (v === 'brand-accent') return 'hsl(var(--accent, 220 14% 92%))';
    if (v === 'brand-foreground') {
      if (context === 'background') return 'hsl(var(--background, 0 0% 100%))';
      return 'hsl(var(--foreground, 220 13% 12%))';
    }
    if (v === 'brand-background') {
      if (context === 'text') return 'hsl(var(--foreground, 220 13% 12%))';
      return 'hsl(var(--background, 0 0% 100%))';
    }
    if (v === 'brand-muted') {
      if (context === 'text') return 'hsl(var(--muted-foreground, 220 9% 46%))';
      return 'hsl(var(--muted, 220 14% 96%))';
    }
    return v;
  };
  const sanitizeUrl = (v: unknown): string | null => {
    if (typeof v !== 'string' || v.length === 0 || v.length > 2048) return null;
    if (!/^https:\/\//.test(v)) return null;
    if (/["'<>{}\\]/.test(v)) return null;
    return v;
  };
  // Draft preview typography wins over committed when the cookie is set
  // and the API still has the bundle in Redis. Otherwise falls back to
  // store.typography (committed values).
  const effectiveTypographyRaw = draftBundle?.typography ?? store.typography;
  const typo = effectiveTypographyRaw as
    | {
        fonts?: Array<
          | { type: 'google'; url?: string; family?: string }
          | {
              type: 'custom';
              family?: string;
              url?: string;
              format?: string;
              weight?: string;
              style?: string;
            }
        >;
        zones?: Record<string, Record<string, string>>;
      }
    | null
    | undefined;
  const googleFontUrls: string[] = [];
  const fontFaceRules: string[] = [];
  if (typo?.fonts && Array.isArray(typo.fonts)) {
    for (const f of typo.fonts) {
      const url = sanitizeUrl(f.url);
      if (!url) continue;
      if (f.type === 'google') {
        googleFontUrls.push(url);
      } else if (f.type === 'custom') {
        const family = sanitizeFontValue(f.family);
        const format = ['woff2', 'woff', 'ttf', 'otf'].includes(String(f.format))
          ? String(f.format)
          : 'woff2';
        if (!family) continue;
        const weight = sanitizeFontValue(f.weight) ?? 'normal';
        const style = f.style === 'italic' ? 'italic' : 'normal';
        fontFaceRules.push(
          `@font-face{font-family:'${family}';src:url('${url}') format('${format}');font-weight:${weight};font-style:${style};font-display:swap;}`
        );
      }
    }
  }
  const zoneRules: string[] = [];
  if (typo?.zones) {
    for (const zone of ZONE_NAMES) {
      const cfg = typo.zones[zone];
      if (!cfg || typeof cfg !== 'object') continue;
      const decls: string[] = [];
      const fam = sanitizeFontValue(cfg.fontFamily);
      // font-family carries !important so it beats per-theme pack-styles
      // Tailwind utility classes (`font-serif` / `font-sans` / `font-mono`)
      // which match the same element with equal specificity (0,1,0) and
      // win via Tailwind v4 layer ordering. Verified on wadyaljuz 2026-05-18
      // where merchant-selected Tajawal in admin wasn't applying to the
      // h2[data-zone="sectionTitle"] inside elegant's font-serif h2.
      // Other zone declarations stay on normal cascade so a merchant who
      // sets only color/size/weight doesn't override pack-style defaults
      // they didn't touch.
      if (fam) decls.push(`font-family:${fam} !important`);
      const size = sanitizeFontValue(cfg.fontSize);
      if (size) decls.push(`font-size:${size}`);
      const weight = sanitizeFontValue(cfg.fontWeight);
      if (weight) decls.push(`font-weight:${weight}`);
      const lh = sanitizeFontValue(cfg.lineHeight);
      if (lh) {
        decls.push(`line-height:${lh}`);
      } else if (size) {
        // When the merchant bumps font-size but doesn't touch
        // line-height, the parent's existing tight line-height (often
        // 1.0–1.2 in template card containers) clips the top of
        // Arabic letters that have upper diacritics or extensions
        // (ش / خ / ة / ه). Pin a safe Arabic-friendly default of 1.6
        // alongside the size so the new larger glyphs always have
        // vertical room. Merchant-supplied lineHeight (above) wins.
        decls.push('line-height:1.6');
      }
      const ls = sanitizeFontValue(cfg.letterSpacing);
      if (ls) decls.push(`letter-spacing:${ls}`);
      const ta = sanitizeFontValue(cfg.textAlign);
      if (ta) decls.push(`text-align:${ta}`);
      const color = sanitizeFontValue(cfg.color);
      if (color) decls.push(`color:${resolveColorValue(color, 'text')}`);

      // Label / chip styling — backgroundColor, padding, borderRadius.
      // When any of these are set on an inline-rendered zone (most zones
      // are inline contexts like spans inside h2/p), padding doesn't
      // visually apply. Auto-emit `display:inline-block` so the chip
      // renders correctly without forcing the merchant to know that.
      const bg = sanitizeFontValue(cfg.backgroundColor);
      const padding = sanitizeFontValue(cfg.padding);
      const radius = sanitizeFontValue(cfg.borderRadius);
      if (bg) decls.push(`background-color:${resolveColorValue(bg, 'background')}`);
      if (padding) decls.push(`padding:${padding}`);
      if (radius) decls.push(`border-radius:${radius}`);
      if ((bg || padding || radius) && !cfg.display) {
        decls.push('display:inline-block');
      }

      // Text decoration — underline / line-through / none plus colour +
      // thickness + offset for fine control. Decoration colour follows
      // the same text-context substitution as color above.
      const td = sanitizeFontValue(cfg.textDecoration);
      // `none` is a deliberate "force off" — emit it !important so it beats a
      // pack class like `hover:underline` (modern seeAll) and any inherited
      // decoration. Other values stay normal-weight so inline/per-section
      // overrides can still win. (Ahmad 2026-06-04: "no decoration force off".)
      if (td) decls.push(`text-decoration:${td}${td === 'none' ? ' !important' : ''}`);
      const tdc = sanitizeFontValue(cfg.textDecorationColor);
      if (tdc) decls.push(`text-decoration-color:${resolveColorValue(tdc, 'text')}`);
      const tdt = sanitizeFontValue(cfg.textDecorationThickness);
      if (tdt) decls.push(`text-decoration-thickness:${tdt}`);
      const tuo = sanitizeFontValue(cfg.textUnderlineOffset);
      if (tuo) decls.push(`text-underline-offset:${tuo}`);

      if (decls.length === 0) continue;
      // Apply to the zone container AND every descendant — that way
      // a merchant who picks "Header = Playfair" doesn't have to
      // re-tag every <h1>/<a>/<span> inside the header. Using a CSS
      // selector instead of a CSS variable keeps templates from
      // having to be rewritten to read the variable.
      zoneRules.push(`[data-zone="${zone}"], [data-zone="${zone}"] *{${decls.join(';')}}`);
    }
    // Override-safety for the sectionKicker divider design (Ahmad
    // 2026-05-17): the default kicker rendering is an editorial divider
    // (two hairline rules flanking the text). When a merchant explicitly
    // configures chip styling on the sectionKicker zone (any of
    // backgroundColor / padding / borderRadius), suppress the divider
    // lines so the merchant's chip renders without the flanking rules.
    const kickerCfg = typo.zones.sectionKicker;
    if (
      kickerCfg &&
      typeof kickerCfg === 'object' &&
      (sanitizeFontValue(kickerCfg.backgroundColor) ||
        sanitizeFontValue(kickerCfg.padding) ||
        sanitizeFontValue(kickerCfg.borderRadius))
    ) {
      zoneRules.push(`[data-kicker-divider-line]{display:none}`);
    }
  }
  // Combine the typography rules into the same style tag the theme
  // already injects — keeps the surface area minimal and avoids
  // duplicate <style> blocks. All inputs above pass through
  // sanitizeFontValue/sanitizeUrl to prevent CSS-injection escapes.
  const typographyCss = [...fontFaceRules, ...zoneRules].join('\n');
  const combinedStyleTag = [themeStyleTag, typographyCss].filter(Boolean).join('\n');

  return (
    <html lang={lang} dir={dir} suppressHydrationWarning>
      <head>
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(orgJsonLd) }}
        />
        {googleFontUrls.map(url => (
          <link key={url} rel="stylesheet" href={url} />
        ))}
        {combinedStyleTag && <style dangerouslySetInnerHTML={{ __html: combinedStyleTag }} />}
        {/* Detect system dark mode preference and apply .dark class before paint */}
        <script
          dangerouslySetInnerHTML={{
            __html: `
              try {
                if (window.matchMedia('(prefers-color-scheme: dark)').matches) {
                  document.documentElement.classList.add('dark');
                }
                window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', function(e) {
                  document.documentElement.classList.toggle('dark', e.matches);
                });
              } catch (e) {}
            `,
          }}
        />
        {/* Favicon is set via generateMetadata().icons -- no manual <link> needed */}
        {/* Manifest is generated by src/app/manifest.ts -- Next.js links it automatically */}
      </head>
      <body
        // pb-32 on mobile reserves 128px at the body level so the fixed
        // mobile BottomTabBar (56 + safe-area-inset ≈ 90px) doesn't cover
        // the cookieFallback row that renders BELOW ShopChrome as a body
        // sibling. ShopChrome carries its own pb-32 for content inside it;
        // body-level reserve is the only way to also protect siblings
        // rendered after ShopChrome by the providers. Ahmad 2026-05-17 evening.
        className={`${plusJakarta.variable} ${ibmPlexArabic.variable} font-sans antialiased bg-background text-foreground overflow-x-hidden pb-32 md:pb-0`}
      >
        {/* Reset scroll to top on every route change — the body is the scroll
            container (overflow-x-hidden), so Next's window-targeted scroll
            restoration alone leaves pages loading mid-page. */}
        <ScrollToTop />
        <a
          href="#main-content"
          className="sr-only focus:not-sr-only focus:absolute focus:top-4 focus:start-4 focus:z-[9999] focus:rounded-lg focus:bg-background focus:px-4 focus:py-2 focus:text-sm focus:font-medium focus:text-foreground focus:shadow-lg focus:outline-none focus:ring-2 focus:ring-primary focus:ring-offset-2"
        >
          Skip to main content
        </a>
        <StoreProvider initialStore={store} previewDraftToken={draftToken}>
          <LanguageProvider defaultLanguage={resolvedLanguage}>
            <ConsentProvider initialConsent={resolvedConsent}>
              {/* PostHog product analytics — mounted INSIDE ConsentProvider
                  so it can read the consent state. Init is gated on
                  marketing-consent (see PostHogProvider). When consent is
                  off OR NEXT_PUBLIC_POSTHOG_KEY is missing, the provider
                  renders children as-is with no SDK init — safe in dev
                  and pre-account-creation. */}
              <PostHogProvider>
                {store.status === 'suspended' ? (
                  // Suspended store — render the branded maintenance page in
                  // place of the entire normal storefront. We deliberately
                  // skip Cart/Auth/Feature providers, marketing pixels, the
                  // service worker, OneSignal, the affiliate tracker, etc.
                  // because they all make API calls (cart sync, /auth/me,
                  // pixel events) that would either 403 against a suspended
                  // store or pollute analytics. The maintenance screen only
                  // needs the store's branding + theme + language, all of
                  // which already live above this guard.
                  <div id="main-content">
                    <StoreMaintenance />
                  </div>
                ) : (
                  <FeatureProvider>
                    <AuthProvider>
                      <ToastProvider>
                        <CartProvider>
                          <div id="main-content">{children}</div>
                          <PushNotificationPrompt />
                          <OneSignalStorefrontInit />
                          {/* Activates ONLY when ?probe=typography is on
                          the URL and the page is in a trusted-admin
                          iframe. Measures real getComputedStyle()
                          values per data-zone and posts them back to
                          the admin so the typography form can show
                          real inherited defaults. */}
                          <TypographyProbe />
                        </CartProvider>
                      </ToastProvider>
                    </AuthProvider>
                    {/* Marketing pixels render ONLY when the visitor has
                    consented (read from the `force-cookie-consent` cookie
                    server-side). No consent → scripts never reach the
                    browser. GDPR/ePrivacy/Kuwait Law 13/2023 compliance. */}
                    {marketingConsentGranted &&
                      store.marketingPixels &&
                      Object.keys(store.marketingPixels).length > 0 && (
                        <MarketingPixelsProvider
                          pixels={store.marketingPixels as MarketingPixels}
                        />
                      )}
                    {/* PWA is active only when BOTH the store toggle AND the
                    platform feature flag are on. Without this gate, flipping
                    the per-store feature off had no observable effect. */}
                    {store.pwaEnabled === true &&
                      (store.enabledFeatures?.includes('pwa') ?? true) && (
                        <ServiceWorkerRegistration />
                      )}
                    <Suspense fallback={null}>
                      <AffiliateTracker />
                    </Suspense>
                  </FeatureProvider>
                )}
                {/* Cookie consent UI — always mounted (banner self-hides
                when the user has already decided; modal opens via the
                footer "Cookie preferences" link or banner Customize). */}
                <CookieConsentBanner />
                <CookiePreferencesModal />
                {/* SSR-rendered compliance fallback (GDPR Art. 7(3) —
                  link must be reachable in initial HTML for no-JS
                  visitors + crawlers). Visible on regular pages, hidden
                  on loading screens via the [data-loading] body marker
                  set by loading.tsx files. Ahmad 2026-05-16: 'return
                  [the cookies] but keep it out of any loading screen as
                  the rest of items'. */}
                <div
                  data-zone="cookieFallback"
                  className="border-t border-border/30 bg-background [body:has([data-loading])_&]:hidden"
                >
                  <div className="container mx-auto px-4 py-3 text-center">
                    <CookiePreferencesLink className="text-xs text-muted-foreground/70 hover:text-foreground transition-colors duration-200 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2" />
                  </div>
                </div>
              </PostHogProvider>
            </ConsentProvider>
          </LanguageProvider>
        </StoreProvider>
      </body>
    </html>
  );
}
