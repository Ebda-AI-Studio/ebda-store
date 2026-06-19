'use client';

import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { api, API_URL } from '../lib/api';
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
  colorToHslTriplet,
} from '@force/shared';

/**
 * Convert theme to CSS custom properties
 * Defined locally to avoid module resolution issues. Mirrors the version
 * in @force/shared/src/types/store-theme.ts — keep in sync when adding
 * tokens.
 */
function themeToCssVars(theme: StoreTheme): Record<string, string> {
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
    // readable foregrounds (wadyaljuz) pass through verbatim.
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
  template: TemplateId;
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
  layout: import('@force/shared').StoreLayoutSettings | null;
  /**
   * Draft-only store.settings overrides (navMenu / footerLinks / utilityBar).
   * Present only when a preview-draft token is active AND the bundle includes
   * settings. ShopChrome prefers these over the committed store.settings so
   * nav/footer/utility changes preview before save. Null for normal visitors.
   */
  draftSettings: Record<string, unknown> | null;
}

const StoreContext = createContext<StoreContextValue | null>(null);

/**
 * Default store for initial render
 */
const DEFAULT_STORE: StoreData = {
  id: 'demo',
  name: 'Force',
  nameAr: 'فورس',
  slug: 'demo',
  status: 'active',
  currency: 'KWD',
  timezone: 'Asia/Kuwait',
  template: 'modern',
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
}

/**
 * Apply theme CSS variables to the document
 */
function applyTheme(theme: StoreTheme | undefined): void {
  if (typeof document === 'undefined') return;
  if (!theme) return;

  const cssVars = themeToCssVars(theme);
  const root = document.documentElement;

  Object.entries(cssVars).forEach(([property, value]) => {
    root.style.setProperty(property, value);
  });
}

export function StoreProvider({ children, initialStore, previewDraftToken }: StoreProviderProps) {
  // Merge initialStore with defaults to ensure theme is always present
  const mergedInitialStore = initialStore
    ? { ...DEFAULT_STORE, ...initialStore, theme: initialStore.theme || DEFAULT_THEME }
    : DEFAULT_STORE;

  const [store] = useState<StoreData>(mergedInitialStore);
  const [isLoading] = useState(!initialStore);
  const [error] = useState<Error | null>(null);
  const [layout, setLayout] = useState<import('@force/shared').StoreLayoutSettings | null>(null);
  // Draft-only settings (navMenu / footerLinks / utilityBar). Populated from
  // the layout-draft bundle when a preview token is active; null otherwise so
  // the live path (no draft) is completely unchanged.
  const [draftSettings, setDraftSettings] = useState<Record<string, unknown> | null>(null);

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
            layout?: import('@force/shared').StoreLayoutSettings;
            settings?: Record<string, unknown>;
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

  // Apply theme on mount and when theme changes
  useEffect(() => {
    applyTheme(store.theme || DEFAULT_THEME);
  }, [store.theme]);

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
    <StoreContext.Provider value={{ store, isLoading, error, layout, draftSettings }}>
      {children}
    </StoreContext.Provider>
  );
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
 * Hook to build store-prefixed URLs.
 * On platform domains (vercel.app, etc.), URLs are prefixed with /{slug}.
 * On custom domains, URLs are returned as-is.
 */
export function useStoreUrl() {
  const { store } = useStore();

  // Compute platform check in state to avoid hydration mismatch.
  //
  // Treat the current hostname as a "platform" host (where store URLs need
  // to be slug-prefixed) when:
  //   1. it's a Vercel preview / production deploy (`*.vercel.app`)
  //   2. it's local dev (`localhost`, `127.0.0.1`)
  //   3. it's the production storefront platform domain
  //      (`store.forcemediakw.com`) — this used to be missed, so links from
  //      stores on the new domain returned bare `/products` instead of
  //      `/<slug>/products` and the bare-root redirect kicked in.
  // Otherwise it's a custom merchant domain — store routes resolve at the
  // root path so no prefix is needed.
  const [isPlatform, setIsPlatform] = useState(false);
  useEffect(() => {
    const host = window.location.hostname;
    setIsPlatform(
      host.endsWith('.vercel.app') ||
        host === 'localhost' ||
        host === '127.0.0.1' ||
        host === 'store.forcemediakw.com'
    );
  }, []);

  const prefix = isPlatform && store.slug && store.id !== 'demo' ? `/${store.slug}` : '';

  return useCallback(
    (path: string) => {
      if (!prefix) return path;
      // Don't double-prefix
      if (path.startsWith(prefix)) return path;
      return `${prefix}${path.startsWith('/') ? path : `/${path}`}`;
    },
    [prefix]
  );
}
