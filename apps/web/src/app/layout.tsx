import { permanentRedirect, redirect } from 'next/navigation';
import type { Metadata, Viewport } from 'next';
import { Suspense } from 'react';
import { cookies, headers } from 'next/headers';
import { Plus_Jakarta_Sans, IBM_Plex_Sans_Arabic } from 'next/font/google';
import { ToastProvider } from '@ebda/ui';
import { LanguageProvider } from '../contexts/LanguageContext';
import { StoreProvider } from '../contexts/StoreContext';
import { CartProvider } from '../contexts/CartContext';
import { AuthProvider } from '../contexts/AuthContext';
import { FeatureProvider } from '../contexts/FeatureContext';
import { getStore } from '../lib/store-resolver';
import { storeThemeColor } from '../lib/theme-color';
import { isPlatformFromHeader } from '../lib/platform-host';
import { API_URL } from '../lib/api';
import { getSiteUrl, organizationJsonLd } from '../lib/structured-data';
import { buildStorefrontMetadata } from '../lib/storefront-metadata';
import { MarketingPixelsProvider } from '../components/MarketingPixels';
import { PostHogProvider } from '../components/PostHogProvider';
import { ServiceWorkerRegistration } from '../components/ServiceWorkerRegistration';
import { SkipLink } from '../components/SkipLink';
import { ScrollToTop } from '../components/ScrollToTop';
import { PushNotificationPrompt } from '../components/PushNotificationPrompt';
import { OneSignalStorefrontInit } from '../components/OneSignalStorefrontInit';
import { TypographyProbe } from '../components/TypographyProbe';
import { AffiliateTracker } from '../components/AffiliateTracker';
import { StoreMaintenance } from '../components/StoreMaintenance';
import { resolveStorefrontLocale } from '../lib/seo/resolve-locale';
import {
  LOCALE_PATH_HEADER,
  LOCALE_PENDING_HEADER,
  localizeJsonLdUrls,
  LOCALE_REST_HEADER,
  LOCALE_SEARCH_HEADER,
  pendingRedirect,
} from '../lib/locale-paths';
import { LocalePathProvider } from '../contexts/LocalePathContext';
import { ConsentProvider, type ConsentState } from '../contexts/ConsentContext';
import { CookieConsentBanner } from '../components/CookieConsentBanner';
import { CookiePreferencesModal } from '../components/CookiePreferencesModal';
import { CookiePreferencesLink } from '../components/CookiePreferencesLink';
import { type MarketingPixels, BRAND, lookTraitAttrs, resolveDefaultLanguage } from '@ebda/shared';
import { buildThemeStyleTag } from '../lib/theme-css';
import { lookHead } from '../lib/look-head';
import { DemoLookBar } from '../components/demo/DemoLookBar';
import { jsonLdScriptContent } from '../lib/json-ld-script';
import '../styles/globals.css';
import { RenderClockProvider } from '../contexts/RenderClockContext';

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

export async function generateViewport(): Promise<Viewport> {
  const store = await getStore();
  return {
    width: 'device-width',
    initialScale: 1,
    maximumScale: 5,
    // viewport-fit=cover so iPhone safe-area-inset env vars resolve to
    // real pixel values; lets a future bottom utility / floating add-to-cart
    // bar sit above the home indicator instead of overlapping it.
    viewportFit: 'cover',
    // K-08: the store's page colour (platform pages keep Ebda's night).
    themeColor: storeThemeColor(store?.theme),
  };
}

export async function generateMetadata(): Promise<Metadata> {
  const store = await getStore();

  // Detect whether we're rendering for the merchant's custom domain
  // (demo-merchant.com) vs the platform path (<slug>.ebda.app).
  // The signal is the request host header. When on the custom domain,
  // GSC verification needs the merchant's own token — emitting the
  // platform token alongside breaks verification (GSC reads only the
  // first meta tag) AND leaks "this site is hosted by Force" to crawlers
  // that scan the meta tags. On the platform path, the platform token
  // owns the domain and is what GSC verifies against.
  const requestHost = (await headers()).get('host')?.toLowerCase() ?? '';
  const isOnCustomDomain = !!(store.domain && requestHost === store.domain.toLowerCase());

  // A store WAS named but the API could not be reached (429/5xx/network), so
  // the resolver handed back the flagged fallback. The page below this layout
  // is rendering the "we're a little busy" retry body — so the title must NOT
  // say the page does not exist. That claim in the <title> survives into the
  // tab, the tab-switcher, a bookmark and every link preview, which is the
  // same lie this work removes from the body, just relocated to the head.
  // Store-neutral on purpose: during a transient we do not know the merchant's
  // name, and guessing one is worse than saying nothing.
  if (store.transientResolveFailure) {
    return {
      title: 'Temporarily unavailable — please try again',
      description: 'This store is busy right now. Please try again in a moment.',
      robots: { index: false, follow: false },
    };
  }

  // Bare platform host (no custom domain, no slug) resolves to DEFAULT_STORE,
  // whose name is "Force" — which produced the merchant-shaped title
  // a generic platform title for a store that does not exist. The
  // root now redirects to ebda.app, so the ONLY page that renders under this
  // sentinel is the platform 404; title it as one and keep it out of the index.
  // Without this the tab still reads like the old marketing page even though
  // the body is a 404 — the title kept making a promise the page no longer did.
  if (store.id === 'demo') {
    return {
      title: `Page not found — ${BRAND.product.nameEn}`,
      description: `This page does not exist. ${BRAND.product.nameEn} builds online stores for merchants.`,
      robots: { index: false, follow: false },
    };
  }

  // Same cookie-then-store-default decision RootLayout uses for <html lang>.
  const locale = await resolveStorefrontLocale(
    (store.settings as Record<string, unknown> | undefined)?.defaultLanguage as string | undefined
  );

  return buildStorefrontMetadata(store, isOnCustomDomain, locale);
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
  const renderNow = Date.now();
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
  const urlLang = (await headers()).get(LOCALE_PATH_HEADER);
  // Preview-draft propagation (set by middleware). Header wins for FIRST
  // load with ?_layoutDraft= in the URL (cookies set in the response
  // aren't visible to the same response's server components). Cookie
  // fallback covers subsequent navigations within the iframe.
  const headersList = await headers();
  // The per-request CSP nonce set by middleware.ts: script-src accepts only nonced scripts (Ruling CSP-WEB-1).
  const nonce = headersList.get('x-nonce') ?? undefined;
  // An old unprefixed URL of a store with language-in-the-URL ON (LOCALE-PATHS-1): the middleware has no store, so it
  // marked the request; here the store's own `settings.defaultLanguage` decides where it goes. Permanent to the default
  // language, temporary to the visitor's cookie language when it differs.
  // Not for the unresolved-store sentinel (`id: 'demo'`, an unknown host) or a transient resolve failure: those must
  // fall through to the page's own 404 / retry body, never a redirect (the deploy probe expects 404 on an unknown host).
  if (
    headersList.get(LOCALE_PENDING_HEADER) === '1' &&
    store.id !== 'demo' &&
    !store.transientResolveFailure
  ) {
    const target = pendingRedirect({
      rest: headersList.get(LOCALE_REST_HEADER) || '/',
      search: headersList.get(LOCALE_SEARCH_HEADER) || '',
      defaultLocale: resolveDefaultLanguage(
        (store.settings as Record<string, unknown> | undefined)?.defaultLanguage as
          | string
          | undefined
      ),
      cookieLocale: cookieLang,
    });
    if (target.permanent) permanentRedirect(target.location);
    redirect(target.location);
  }
  const draftToken =
    headersList.get('x-preview-draft') ?? cookieStore.get('force-preview-draft')?.value;
  // Middleware already resolved platform-vs-custom-domain for this request
  // (`x-is-platform`) — hand it to StoreProvider so the FIRST render already
  // knows, instead of guessing `false` until a client `useEffect` corrects
  // it. See StoreContext.tsx's `isPlatform` doc comment. Tri-state: an
  // ABSENT header (middleware did not run) stays `undefined` so the client
  // fallback still runs (#2091).
  const initialIsPlatform = isPlatformFromHeader(headersList.get('x-is-platform'));
  // API_URL already includes the /api/v1 prefix (see lib/api.ts); the helper
  // appends the route path directly to avoid a doubled /api/v1/api/v1/ 404.
  const draftBundle = await fetchDraftBundleForCurrentRequest(store.id, draftToken, API_URL);
  const storeDefaultLanguage = (store.settings as Record<string, unknown>)?.defaultLanguage as
    | 'en'
    | 'ar'
    | undefined;
  // A `/ar|/en` URL (LOCALE-PATHS-1) wins over the cookie, then the store's default.
  const resolvedLanguage: 'en' | 'ar' =
    urlLang === 'ar' || urlLang === 'en'
      ? urlLang
      : cookieLang === 'ar' || cookieLang === 'en'
        ? cookieLang
        : resolveDefaultLanguage(storeDefaultLanguage);
  const lang = resolvedLanguage;
  const dir = resolvedLanguage === 'ar' ? 'rtl' : 'ltr';

  // Cookie consent — read server-side so MarketingPixelsProvider is only
  // RENDERED into the HTML when the user has consented to marketing.
  // GDPR Art. 6(a) + ePrivacy + applicable GCC data-protection law
  // (see docs/privacy/data-map.md) require prior consent
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

  // Organization JSON-LD for search engines. `resolvedLanguage` (above) is
  // the SAME cookie-then-store-default decision that picked `<html lang>` —
  // reusing it here (rather than re-deriving) is what guarantees this
  // JSON-LD's `description` can never disagree with the page it's on.
  const orgJsonLd = organizationJsonLd(store, resolvedLanguage);

  // Build a <style> tag that overrides the default (Ebda night) theme in globals.css
  // Inline styles on <html> don't beat `:root {}` in @layer base, so we inject a :root rule instead.
  // When an unsaved page-builder PREVIEW draft is active, merge its pending theme
  // over the committed theme so the preview iframe paints EXACTLY what the
  // storefront will (PLP breadcrumb/heading/subtitle colors + palette tokens) —
  // otherwise those theme-driven colors showed live but not in the preview.
  const effectiveTheme = draftBundle?.theme
    ? { ...(store.theme ?? {}), ...(draftBundle.theme as Record<string, unknown>) }
    : store.theme;
  const themeStyleTag = buildThemeStyleTag(effectiveTheme, store.look);

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
  // Fallback HSL values mirror @ebda/ui's default theme palette.
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
    // Verified 2026-05-20 — demo-merchant had merchant picked `token:card` for
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
      // win via Tailwind v4 layer ordering. Verified on demo-merchant 2026-05-18
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
  const look = lookHead(
    store.look,
    effectiveTheme as { headingFont?: unknown; bodyFont?: unknown } | null
  );
  const combinedStyleTag = [themeStyleTag, typographyCss].filter(Boolean).join('\n');

  return (
    // globals.css turns on `scroll-behavior: smooth` for html; Next only switches it off while it resets
    // the scroll after a navigation when this attribute is present (without it a page can open scrolled down).
    <html lang={lang} dir={dir} data-scroll-behavior="smooth" suppressHydrationWarning>
      <head>
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{
            __html: jsonLdScriptContent(
              localizeJsonLdUrls(
                orgJsonLd,
                getSiteUrl(store),
                urlLang === 'ar' || urlLang === 'en' ? urlLang : null
              )
            ),
          }}
        />
        {look && (
          <>
            {/* SEO-5: self-hosted faces (inline, non-blocking) + preload of the two primary files. */}
            {look.preloadFonts.map(href => (
              <link
                key={href}
                rel="preload"
                as="font"
                type="font/woff2"
                href={href}
                crossOrigin=""
              />
            ))}
            <style dangerouslySetInnerHTML={{ __html: look.fontFacesCss }} />
          </>
        )}
        {googleFontUrls.map(url => (
          <link key={url} rel="stylesheet" href={url} />
        ))}
        {combinedStyleTag && <style dangerouslySetInnerHTML={{ __html: combinedStyleTag }} />}
        {/* Detect system dark mode preference and apply .dark class before paint */}
        <script
          nonce={nonce}
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
        className={`${plusJakarta.variable} ${ibmPlexArabic.variable} font-sans antialiased bg-background text-foreground pb-32 md:pb-0`}
        // Skin hook for pack-level CSS (globals.css), on the server-rendered body so the first
        // paint already has it (the chrome itself loads on the client). Only the look skins set
        // it: other stores' markup is unchanged. Display faces come from the look (looks/fonts.ts).
        data-pack={
          store.template === 'dahab' ||
          store.template === 'qamar' ||
          store.template === 'souq' ||
          store.template === 'jasmine' ||
          store.template === 'lamma'
            ? store.template
            : undefined
        }
        // Looks (Phase S): scopes every look rule in globals.css; absent for legacy stores.
        data-look={look?.dataLook}
        // TEMPLATES-MOCK-2/-6: the merchant's (else the look's) mock traits, read by globals.css; none for a legacy store.
        {...lookTraitAttrs(effectiveTheme, store.look)}
      >
        {/* Reset scroll to top on every route change — the body is the scroll
            container on browsers without `overflow: clip` (see globals.css, #124), so
            Next's window-targeted scroll restoration alone leaves pages loading mid-page there. */}
        <ScrollToTop />
        <LocalePathProvider locale={urlLang === 'ar' || urlLang === 'en' ? urlLang : null}>
          <StoreProvider
            initialStore={store}
            previewDraftToken={draftToken}
            initialIsPlatform={initialIsPlatform}
          >
            {/* One clock for the whole render, shared by server HTML and hydration
              (the card "New" badge; W1c review M9). */}
            <RenderClockProvider now={renderNow}>
              <LanguageProvider defaultLanguage={resolvedLanguage}>
                {/* Skip link: still the first focusable element in <body>, now named in
                the page's language (R-05). */}
                <SkipLink />
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
                          <ToastProvider
                            dismissLabel={lang === 'ar' ? 'إغلاق الإشعار' : 'Dismiss notification'}
                          >
                            <CartProvider>
                              {store.isDemo && <DemoLookBar activeLook={store.look} />}
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
                    browser. GDPR/ePrivacy/applicable GCC data-protection
                    law compliance (see docs/privacy/data-map.md). */}
                        {marketingConsentGranted &&
                          store.marketingPixels &&
                          Object.keys(store.marketingPixels).length > 0 && (
                            <MarketingPixelsProvider
                              pixels={store.marketingPixels as MarketingPixels}
                              nonce={nonce}
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
                    {/* No store resolved (unknown/inactive host, platform host, transient
                  fallback): the page is the generic Ebda Store 404 / retry body. It sets no
                  tracking, so there is nothing to consent to, and the banner's default-
                  theme primary must not be the only colour on an Ebda Store page
                  (Ruling SUBDOMAIN-404-1). */}
                    {store.id !== 'demo' && (
                      <>
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
                            <CookiePreferencesLink className="inline-flex min-h-11 min-w-11 items-center justify-center text-xs text-muted-foreground hover:text-foreground transition-colors duration-200 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2" />
                          </div>
                        </div>
                      </>
                    )}
                  </PostHogProvider>
                </ConsentProvider>
              </LanguageProvider>
            </RenderClockProvider>
          </StoreProvider>
        </LocalePathProvider>
      </body>
    </html>
  );
}
