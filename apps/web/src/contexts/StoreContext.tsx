'use client';

import { useLocalePath } from './LocalePathContext';
import { localizeHref } from '../lib/locale-paths';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import {
  applyThemePatch,
  chromeLogoColumns,
  chromePreviewSettings,
  type DraftChrome,
  type DraftTheme,
} from '@ebda/shared';
import { api, API_URL } from '../lib/api';
import { isPlatformHost } from '../lib/platform-host';
import { setCompareStoreId } from '../lib/compare';
import {
  type StoreTheme,
  type StoreSocialLinks,
  type AnnouncementBar,
  type TemplateId,
  DEFAULT_THEME,
  BORDER_RADIUS_MAP,
  FONT_FAMILY_MAP,
  resolveBackgroundPreset,
  deriveBrandRoles,
  lookCssVars,
  colorToHslTriplet,
  statusInkVars,
  REGION,
  BRAND,
} from '@ebda/shared';

/**
 * Convert theme to CSS custom properties
 * Defined locally to avoid module resolution issues. Mirrors the version
 * in @ebda/shared/src/types/store-theme.ts — keep in sync when adding
 * tokens.
 */
export function themeToCssVars(theme: StoreTheme, lookId?: string | null): Record<string, string> {
  const bg = resolveBackgroundPreset(theme);
  const vars: Record<string, string> = {
    '--primary': theme.primaryColor,
    '--primary-foreground': theme.primaryForeground,
    '--secondary': theme.secondaryColor,
    '--secondary-foreground': theme.secondaryForeground,
    '--accent': theme.accentColor,
    '--accent-foreground': theme.accentForeground,
    '--background': theme.backgroundColor,
    '--foreground': theme.foregroundColor,
    '--muted': theme.mutedColor,
    '--muted-foreground': theme.mutedForeground,
    '--border': theme.borderColor,
    '--card': theme.cardColor,
    '--card-foreground': theme.cardForeground,
    '--popover': theme.popoverColor,
    '--popover-foreground': theme.popoverForeground,
    '--input': theme.inputColor,
    '--ring': theme.ringColor,
    '--destructive': theme.destructiveColor,
    '--destructive-foreground': theme.destructiveForeground,
    '--success': theme.successColor,
    '--success-foreground': theme.successForeground,
    '--warning': theme.warningColor,
    '--warning-foreground': theme.warningForeground,
    '--radius': BORDER_RADIUS_MAP[theme.borderRadius],
    '--font-family': FONT_FAMILY_MAP[theme.fontFamily],
    // Sprint 1 section-rhythm tokens — see shared store-theme.ts.
    '--bg-page': bg.bgPage,
    '--bg-section-alt': bg.bgSectionAlt,
    // Brand engine (2026-06-05) — contrast-safe overrides for the 4 brand
    // color/foreground pairs. MUST match the shared themeToCssVars so this
    // client mirror agrees with the SSR-emitted vars (no flash). Stored
    // readable foregrounds (demo-shop) pass through verbatim.
    ...deriveBrandRoles(theme),
  };

  // Normalize colour vars to bare HSL triplets (resolve token:* + hex→triplet)
  // so the client-applied vars match the SSR-emitted ones and hex-stored colours
  // render. MUST stay in sync with the shared themeToCssVars.
  const NON_COLOR_VARS = new Set(['--radius', '--font-family']);
  for (const key of Object.keys(vars)) {
    if (NON_COLOR_VARS.has(key)) continue;
    vars[key] = colorToHslTriplet(vars[key], theme);
  }
  // Looks (Phase S) — MUST match the shared themeToCssVars; empty for legacy themes.
  Object.assign(vars, lookCssVars(theme, lookId));
  // Issue 2349 — status-message inks. MUST match the shared themeToCssVars.
  Object.assign(
    vars,
    statusInkVars(
      {
        success: vars['--success'],
        warning: vars['--warning'],
        destructive: vars['--destructive'],
      },
      [vars['--card'], vars['--background']],
      theme.legacyBannerContrast === true
    )
  );
  return vars;
}

/**
 * Store data available in client components
 */
export interface StoreData {
  id: string;
  name: string;
  nameAr?: string;
  slug: string;
  domain?: string;
  /** Lifecycle status. `suspended` triggers the branded maintenance page on
   *  the storefront — every page wraps in `StoreMaintenanceGate` which
   *  swaps out the normal chrome for the maintenance screen. */
  status: 'active' | 'suspended';
  logo?: string;
  logoAr?: string;
  favicon?: string;
  description?: string;
  descriptionAr?: string;
  currency: string;
  timezone: string;
  /** Merchant's published return window in days: 0 = returns not accepted, null/absent = not declared. */
  returnWindowDays?: number | null;
  template: TemplateId;
  /** Look id; null/absent = legacy store. */
  look?: string | null;
  /** The looks showroom: the layout shows the look bar and checkout shows a notice instead of Pay. */
  isDemo?: boolean;
  theme: StoreTheme;
  socialLinks: StoreSocialLinks;
  email?: string;
  phone?: string;
  phoneAr?: string;
  whatsapp?: string;
  address?: string;
  addressAr?: string;
  announcementBar?: AnnouncementBar;
  metaTitle?: string;
  metaTitleAr?: string;
  metaDescription?: string;
  metaDescriptionAr?: string;
  metaDescriptionAeo?: string;
  metaDescriptionAeoAr?: string;
  ogImage?: string;
  twitterHandle?: string;
  googleSiteVerification?: string;
  pwaEnabled?: boolean;
  /** Bucket E1 (2026-05-17): opt-in blog feature toggle. */
  blogEnabled?: boolean;
  /** Opt-in physical-locations feature toggle (gates the /locations page + footer link). */
  locationsEnabled?: boolean;
  /**
   * Per-store typography overrides (font family, size, color per zone).
   * Shape mirrors `ResolvedStore.typography` and `Store.typography` JSON.
   * Used by HomePageContent for per-section heading inline styles.
   */
  typography?: Record<string, unknown> | null;
  pwaSettings?: Record<string, unknown>;
  settings?: Record<string, unknown>;
  /** When true, customer-facing prices already include VAT and the
   * storefront should label them with an "Includes VAT" note so the
   * customer understands they're not paying tax on top at checkout. */
  taxEnabled?: boolean;
  taxIncludedInPrice?: boolean;
  /** The store's active VAT rate as a percentage (e.g. 5 for 5%). See
   *  `ResolvedStore.taxRatePercent` in lib/store-resolver.ts. */
  taxRatePercent?: number;
  /** Issue 206 — see `ResolvedStore.smsMarketingOptIn` in lib/store-resolver.ts. */
  smsMarketingOptIn?: boolean;
  /** See `ResolvedStore.cartEmailOptIn` in lib/store-resolver.ts. */
  cartEmailOptIn?: boolean;
  whatsappMarketingOptIn?: boolean;
  enabledFeatures?: string[];
  /**
   * Slugs of CMS pages the merchant has explicitly disabled
   * (`isPublished=false`). Forwarded from the public store endpoint so
   * the footer can hide bottom-bar legal links pointing to disabled
   * pages without a dedicated round-trip.
   */
  disabledCmsSlugs?: string[];
  heroTitle?: string | null;
  heroTitleAr?: string | null;
  heroSubtitle?: string | null;
  heroSubtitleAr?: string | null;
  heroCtaText?: string | null;
  heroCtaTextAr?: string | null;
  heroCtaLink?: string | null;
  heroImage?: string | null;
  faqs?: Array<{
    id: string;
    question: string;
    questionAr?: string | null;
    answer: string;
    answerAr?: string | null;
  }>;
  howtos?: Array<{
    id: string;
    title: string;
    titleAr?: string | null;
    description: string;
    descriptionAr?: string | null;
    steps: Array<{ name: string; text: string; image?: string }>;
    stepsAr?: Array<{ name: string; text: string; image?: string }> | null;
  }>;
  /**
   * Published store locations — mirrors `ResolvedStore.locations`
   * (store-resolver.ts). Only present when the API included it, which it
   * does only when `locationsEnabled && theme.showBranchesInFooter`. See
   * `templates/shared/display-helpers.ts::resolveFooterBranches`.
   */
  locations?: import('@ebda/shared').StoreLocationPublic[];
}

interface StoreContextValue {
  store: StoreData;
  isLoading: boolean;
  error: Error | null;
  /**
   * Per-page layout settings. Fetched lazily on mount so non-homepage routes
   * (PDP / catalog / blog) can read header/footer chrome overrides from
   * `layout.header` / `layout.footer` via ShopChrome.
   *
   * Null until the fetch resolves. Homepage's HomePageContent passes its own
   * server-fetched layout via the ShopChrome `layout` prop — that wins over
   * this lazy fetch (no race between SSR-fetched-on-server vs lazy-on-client).
   */
  layout: import('@ebda/shared').StoreLayoutSettings | null;
  /**
   * Draft-only store.settings overrides (navMenu / footerLinks / utilityBar).
   * Present only when a preview-draft token is active AND the bundle includes
   * settings. ShopChrome prefers these over the committed store.settings so
   * nav/footer/utility changes preview before save. Null for normal visitors.
   */
  draftSettings: Record<string, unknown> | null;
  /**
   * Whether the current request is on a platform host (`ebda.app`,
   * `localhost`, etc.) rather than a merchant's custom domain — see
   * `lib/platform-host.ts`. Seeded server-side from the `x-is-platform`
   * header middleware already sets (`layout.tsx`), so the FIRST render
   * already has the right answer instead of guessing `false` until a
   * `useEffect` corrects it on mount. That gap used to ship a bare `/` home
   * link in the server-rendered HTML on a platform host, reachable by a
   * pre-hydration click or a crawler following the raw href.
   */
  isPlatform: boolean;
}

const StoreContext = createContext<StoreContextValue | null>(null);

/**
 * Default store for initial render
 */
const DEFAULT_STORE: StoreData = {
  id: 'demo',
  name: BRAND.product.nameEn,
  nameAr: BRAND.product.nameAr,
  slug: 'demo',
  status: 'active',
  currency: REGION.currency,
  timezone: 'Africa/Cairo',
  template: 'qamar',
  theme: DEFAULT_THEME,
  socialLinks: {},
};

interface StoreProviderProps {
  children: ReactNode;
  initialStore?: StoreData;
  /**
   * Page-builder preview-draft token (resolved server-side in layout.tsx from
   * the `?_layoutDraft=` param / `force-preview-draft` httpOnly cookie). When
   * present, the lazy layout fetch requests the DRAFT layout so "preview unsaved
   * changes" reflects per-page settings (cart / checkout / categories bg +
   * typography) — not just the homepage. Absent for normal visitors.
   */
  previewDraftToken?: string;
  /**
   * Server-resolved platform-host check (`middleware.ts`'s `x-is-platform`
   * header, read in `layout.tsx` via `isPlatformFromHeader`). `undefined`
   * — header absent, i.e. middleware did not run for this render, or a
   * caller that passes nothing — falls back to the client-side
   * `isPlatformHost()` detection below (#2091: `layout.tsx` used to collapse
   * absent into `false`, which made this fallback unreachable).
   */
  initialIsPlatform?: boolean;
}

/**
 * Apply theme CSS variables to the document
 */
function applyTheme(theme: StoreTheme | undefined, lookId?: string | null): void {
  if (typeof document === 'undefined') return;
  if (!theme) return;

  const cssVars = themeToCssVars(theme, lookId);
  const root = document.documentElement;

  Object.entries(cssVars).forEach(([property, value]) => {
    root.style.setProperty(property, value);
  });
}

export function StoreProvider({
  children,
  initialStore,
  previewDraftToken,
  initialIsPlatform,
}: StoreProviderProps) {
  // Merge initialStore with defaults to ensure theme is always present
  const mergedInitialStore = initialStore
    ? { ...DEFAULT_STORE, ...initialStore, theme: initialStore.theme || DEFAULT_THEME }
    : DEFAULT_STORE;

  const [store] = useState<StoreData>(mergedInitialStore);
  const [isLoading] = useState(!initialStore);
  const [error] = useState<Error | null>(null);
  // Seed from the server's answer when the caller has one; otherwise start
  // `false` and let the effect below correct it on mount (pre-existing
  // client-only fallback — no hydration mismatch either way, since SSR
  // always renders the seeded/false value and the effect only fires after
  // hydration completes).
  const [isPlatform, setIsPlatform] = useState(initialIsPlatform ?? false);
  useEffect(() => {
    if (initialIsPlatform !== undefined) return;
    setIsPlatform(isPlatformHost(window.location.hostname));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const [layout, setLayout] = useState<import('@ebda/shared').StoreLayoutSettings | null>(null);
  // Draft-only settings (navMenu / footerLinks / utilityBar). Populated from
  // the layout-draft bundle when a preview token is active; null otherwise so
  // the live path (no draft) is completely unchanged.
  const [draftSettings, setDraftSettings] = useState<Record<string, unknown> | null>(null);
  // Draft-only theme overrides (PLP colors, palette tokens, etc.) from the
  // preview bundle. Merged over the committed store.theme so consumers that read
  // `store.theme.*` directly (e.g. ProductsClient's PLP colors) reflect the
  // unsaved preview — keeping the preview faithful to the storefront.
  const [draftTheme, setDraftTheme] = useState<Record<string, unknown> | null>(null);

  // Lazy-fetch layout settings for non-homepage routes so ShopChrome can apply
  // header / footer / announcement chrome overrides everywhere, not only home.
  // 60s freshness via the API's Cache-Control header is fine — chrome edits
  // don't need real-time propagation.
  useEffect(() => {
    if (!store.id || store.id === 'demo') return;
    let cancelled = false;
    (async () => {
      try {
        // API_URL already includes the /api/v1 prefix (see lib/api.ts) — do not
        // re-append it here or the request 404s on /api/v1/api/v1/...
        // In the page-builder preview iframe, request the DRAFT layout so cart /
        // checkout / categories reflect unsaved changes like the homepage does.
        const layoutUrl = previewDraftToken
          ? `${API_URL}/public/stores/${store.id}/layout?_layoutDraft=${encodeURIComponent(previewDraftToken)}`
          : `${API_URL}/public/stores/${store.id}/layout`;
        const res = await fetch(layoutUrl, {
          credentials: 'include',
        });
        if (!res.ok) return;
        const data = (await res.json()) as {
          data?: {
            layout?: import('@ebda/shared').StoreLayoutSettings;
            settings?: Record<string, unknown>;
            theme?: Record<string, unknown>;
            isDraft?: boolean;
          };
        };
        if (cancelled) return;
        if (data.data?.layout) setLayout(data.data.layout);
        // When the response is from a draft bundle AND carries settings, expose
        // them as draftSettings so ShopChrome can prefer them over store.settings.
        if (data.data?.isDraft && data.data.settings && typeof data.data.settings === 'object') {
          setDraftSettings(data.data.settings);
        } else {
          setDraftSettings(null);
        }
        // Same for the draft theme — so direct `store.theme.*` reads (PLP colors)
        // reflect the preview. Cleared when there's no draft so the live path is
        // untouched.
        if (data.data?.isDraft && data.data.theme && typeof data.data.theme === 'object') {
          setDraftTheme(data.data.theme);
        } else {
          setDraftTheme(null);
        }
      } catch {
        // Silent: layout chrome is a nice-to-have, fallback is the default chrome.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [store.id, previewDraftToken]);

  // Push the store id into the api client BEFORE any child effects run so the
  // first client-side request already carries X-Store-ID. Using an effect
  // here races with children's useEffects on mount and was the reason the api
  // fell back to the first-created store.
  if (store.id && store.id !== 'demo') {
    api.setStoreId(store.id);
  }
  // Namespace per-store localStorage (compare list) synchronously during render
  // so child components read the right store's key on their first render.
  setCompareStoreId(store.id && store.id !== 'demo' ? store.id : null);

  // The store exposed to consumers, with any unsaved preview theme merged in so
  // `store.theme.*` reads (e.g. ProductsClient PLP colors) match the preview.
  const effectiveStore = useMemo(
    () =>
      draftTheme
        ? { ...store, theme: { ...(store.theme ?? {}), ...draftTheme } as typeof store.theme }
        : store,
    [store, draftTheme]
  );

  // Apply theme on mount and when theme changes (committed OR draft).
  useEffect(() => {
    applyTheme(effectiveStore.theme || DEFAULT_THEME, effectiveStore.look);
  }, [effectiveStore.theme, effectiveStore.look]);

  // Apply favicon
  useEffect(() => {
    if (store.favicon && typeof document !== 'undefined') {
      const link =
        (document.querySelector("link[rel*='icon']") as HTMLLinkElement) ||
        document.createElement('link');
      link.type = 'image/x-icon';
      link.rel = 'shortcut icon';
      link.href = store.favicon;
      document.getElementsByTagName('head')[0].appendChild(link);
    }
  }, [store.favicon]);

  return (
    <StoreContext.Provider
      value={{ store: effectiveStore, isLoading, error, layout, draftSettings, isPlatform }}
    >
      {children}
    </StoreContext.Provider>
  );
}

/**
 * Builder canvas only: paint the editor's PENDING theme patch (the draft's
 * `PageDefinition.theme`) over the committed store theme, for both React
 * consumers of `store.theme.*` and the `:root` CSS variables. The patch is
 * never part of a public render — only `HomePageBody` mounts this, and only
 * for a valid builder preview token.
 */
export function PreviewThemeOverride({
  theme,
  chrome,
  children,
}: {
  theme: Record<string, unknown> | undefined;
  /** The draft's pending header-menu / footer-links patch (`PageDefinition.chrome`). */
  chrome?: DraftChrome;
  children: ReactNode;
}) {
  const ctx = useStore();
  const value = useMemo(() => {
    const hasTheme = !!theme && Object.keys(theme).length > 0;
    // The same `draftSettings` channel the classic builder's preview uses:
    // ShopChrome prefers it over `store.settings`, and runs every href through
    // its scheme allowlist (sanitizeUrl) before rendering.
    const previewSettings = chromePreviewSettings(ctx.store.settings, chrome);
    // the draft logo is a store column, not a setting: override it on the canvas copy only
    const previewLogos = chromeLogoColumns(chrome);
    const hasLogo = Object.keys(previewLogos).length > 0;
    if (!hasTheme && !previewSettings && !hasLogo) return ctx;
    return {
      ...ctx,
      store:
        hasTheme || hasLogo
          ? {
              ...ctx.store,
              ...previewLogos,
              // a `null` in the patch is a reset: the key is removed so the look default shows
              ...(hasTheme
                ? {
                    theme: applyThemePatch(
                      ctx.store.theme,
                      theme as DraftTheme
                    ) as StoreData['theme'],
                  }
                : {}),
            }
          : ctx.store,
      draftSettings: previewSettings
        ? { ...(ctx.draftSettings ?? {}), ...previewSettings }
        : ctx.draftSettings,
    };
  }, [ctx, theme, chrome]);
  useEffect(() => {
    if (value === ctx || value.store === ctx.store) return;
    // StoreProvider's own effect (a parent, so it runs AFTER this child's) stamps
    // the committed theme on <html>; a microtask lands after that whole flush.
    queueMicrotask(() => applyTheme(value.store.theme, value.store.look));
  }, [value, ctx]);
  return <StoreContext.Provider value={value}>{children}</StoreContext.Provider>;
}

/**
 * Hook to access store data in client components
 */
export function useStore(): StoreContextValue {
  const context = useContext(StoreContext);

  if (!context) {
    throw new Error('useStore must be used within a StoreProvider');
  }

  return context;
}

/**
 * Hook to get the current store's theme
 */
export function useStoreTheme(): StoreTheme {
  const { store } = useStore();
  return store.theme;
}

/**
 * Hook to get the current store's template
 */
export function useStoreTemplate(): TemplateId {
  const { store } = useStore();
  return store.template;
}

/**
 * Hook to get store branding info
 */
export function useStoreBranding() {
  const { store } = useStore();
  return {
    name: store.name,
    nameAr: store.nameAr,
    logo: store.logo,
    logoAr: store.logoAr,
    description: store.description,
    descriptionAr: store.descriptionAr,
  };
}

/**
 * Hook to get store contact info
 */
export function useStoreContact() {
  const { store } = useStore();
  return {
    email: store.email,
    phone: store.phone,
    phoneAr: store.phoneAr,
    whatsapp: store.whatsapp,
    address: store.address,
    addressAr: store.addressAr,
    socialLinks: store.socialLinks,
  };
}

/**
 * Hook to build in-store URLs.
 *
 * Every store has its own host (`<slug>.ebda.app` or a custom domain), so an
 * in-store path is already complete: this returns it unchanged. The old
 * `/<slug>` prefix for path-based platform storefronts is gone — a platform
 * host never renders a store. The hook is kept (rather than deleted) because
 * dozens of call sites build links through it.
 */
export function useStoreUrl() {
  // On a `/ar|/en` page of a store with language-in-the-URL ON (LOCALE-PATHS-1) an internal link to an indexable
  // route carries the page's language prefix; everywhere else this is still the identity.
  const locale = useLocalePath();
  return useCallback((path: string) => localizeHref(path, locale), [locale]);
}

/**
 * Whether this request is on a platform host (`ebda.app`,
 * `localhost`, a preview subdomain) rather than a merchant's custom domain.
 *
 * Exposed separately from `useStoreUrl()` (rather than changing that hook's
 * return shape) because 20+ call sites already destructure it as a bare
 * `storeUrl` function — a shape change there would touch every one of them
 * for no benefit. Consumers that need to make a platform-vs-custom-domain
 * decision (e.g. `RouteErrorFallback` deciding whether "Go Home" is safe to
 * show during a transient) call this instead.
 */
export function useIsPlatform(): boolean {
  return useStore().isPlatform;
}
