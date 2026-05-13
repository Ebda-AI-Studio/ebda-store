import type { Metadata, Viewport } from 'next';
import { Suspense } from 'react';
import { cookies } from 'next/headers';
import { Plus_Jakarta_Sans, IBM_Plex_Sans_Arabic } from 'next/font/google';
import { ToastProvider } from '@force/ui';
import { LanguageProvider } from '../contexts/LanguageContext';
import { StoreProvider } from '../contexts/StoreContext';
import { CartProvider } from '../contexts/CartContext';
import { AuthProvider } from '../contexts/AuthContext';
import { FeatureProvider } from '../contexts/FeatureContext';
import { getStore } from '../lib/store-resolver';
import { organizationJsonLd, getSiteUrl } from '../lib/structured-data';
import { MarketingPixelsProvider } from '../components/MarketingPixels';
import { ServiceWorkerRegistration } from '../components/ServiceWorkerRegistration';
import { PushNotificationPrompt } from '../components/PushNotificationPrompt';
import { OneSignalStorefrontInit } from '../components/OneSignalStorefrontInit';
import { TypographyProbe } from '../components/TypographyProbe';
import { AffiliateTracker } from '../components/AffiliateTracker';
import { StoreMaintenance } from '../components/StoreMaintenance';
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
  const localizedDescription = preferAr
    ? store.metaDescriptionAr || store.metaDescription
    : store.metaDescription;
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

  // Prefer admin-configured Open Graph image; fall back to store logo.
  const ogImageUrl = store.ogImage || store.logo;
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
    metadataBase: new URL(siteUrl),
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
      images: ogImageUrl ? [{ url: ogImageUrl }] : undefined,
    },
    twitter: {
      card: 'summary_large_image',
      title: titleDefault,
      description,
      ...(ogImageUrl ? { images: [ogImageUrl] } : {}),
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
    // Platform-level Google Search Console verification for
    // `store.forcemediakw.com`. The token is meant to be public (Google
    // fetches the meta tag from a public URL), so it lives in source.
    // Per-store tokens are layered on top so individual merchants can
    // also verify their own custom domains independently.
    verification: {
      google: store.googleSiteVerification
        ? ['gzm3VDXL0OakVx_Rf4ytQZSyWZeW4nHg0WLcvxsehVI', store.googleSiteVerification]
        : 'gzm3VDXL0OakVx_Rf4ytQZSyWZeW4nHg0WLcvxsehVI',
    },
  };
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
    'categories',
    'products',
    'footer',
    'afterFooter',
    // Sub-zones — nested inside the broad ones; emitted last so a
    // tied selector still wins on source order, on top of having
    // (usually) the same specificity.
    'sectionTitle',
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
  const sanitizeUrl = (v: unknown): string | null => {
    if (typeof v !== 'string' || v.length === 0 || v.length > 2048) return null;
    if (!/^https:\/\//.test(v)) return null;
    if (/["'<>{}\\]/.test(v)) return null;
    return v;
  };
  const typo = store.typography as
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
      if (fam) decls.push(`font-family:${fam}`);
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
      const color = sanitizeFontValue(cfg.color);
      if (color) decls.push(`color:${color}`);
      if (decls.length === 0) continue;
      // Apply to the zone container AND every descendant — that way
      // a merchant who picks "Header = Playfair" doesn't have to
      // re-tag every <h1>/<a>/<span> inside the header. Using a CSS
      // selector instead of a CSS variable keeps templates from
      // having to be rewritten to read the variable.
      zoneRules.push(`[data-zone="${zone}"], [data-zone="${zone}"] *{${decls.join(';')}}`);
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
        className={`${plusJakarta.variable} ${ibmPlexArabic.variable} font-sans antialiased bg-background text-foreground overflow-x-hidden`}
      >
        <a
          href="#main-content"
          className="sr-only focus:not-sr-only focus:absolute focus:top-4 focus:left-4 focus:z-[9999] focus:bg-white focus:text-black focus:px-4 focus:py-2 focus:rounded-lg focus:shadow-lg focus:text-sm focus:font-medium"
        >
          Skip to main content
        </a>
        <StoreProvider initialStore={store}>
          <LanguageProvider defaultLanguage={resolvedLanguage}>
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
                {store.marketingPixels && Object.keys(store.marketingPixels).length > 0 && (
                  <MarketingPixelsProvider pixels={store.marketingPixels as MarketingPixels} />
                )}
                {/* PWA is active only when BOTH the store toggle AND the
                    platform feature flag are on. Without this gate, flipping
                    the per-store feature off had no observable effect. */}
                {store.pwaEnabled === true && (store.enabledFeatures?.includes('pwa') ?? true) && (
                  <ServiceWorkerRegistration />
                )}
                <Suspense fallback={null}>
                  <AffiliateTracker />
                </Suspense>
              </FeatureProvider>
            )}
          </LanguageProvider>
        </StoreProvider>
      </body>
    </html>
  );
}
