import { headers } from 'next/headers';
import { notFound } from 'next/navigation';
import {
  type StoreTheme,
  type StoreSocialLinks,
  type AnnouncementBar,
  type TemplateId,
  DEFAULT_THEME,
  getTemplateTheme,
} from '@force/shared';
import { API_URL } from './api';

/**
 * Lifecycle status of a resolved store. Mirrors the `StoreStatus` enum on
 * the API side. Customer-facing surfaces only ever see `active` or
 * `suspended`; `inactive` (archived/draft) stores are filtered out by the
 * public store endpoint and never make it to the storefront.
 */
export type ResolvedStoreStatus = 'active' | 'suspended';

/**
 * Resolved store configuration
 */
export interface ResolvedStore {
  id: string;
  name: string;
  nameAr?: string;
  slug: string;
  domain?: string;
  status: ResolvedStoreStatus;
  logo?: string;
  logoAr?: string;
  favicon?: string;
  description?: string;
  descriptionAr?: string;
  currency: string;
  timezone: string;

  // Template & Theme
  template: TemplateId;
  theme: StoreTheme;
  // Per-store typography overrides (font family, size, color per zone
  // + a library of Google Fonts URLs / merchant-uploaded font files).
  // Loaded from Store.typography JSON. Untyped here because the
  // shape lives in @force/shared/types/typography and dragging that
  // import in would force a chain of build dependencies the resolver
  // doesn't currently need.
  typography?: Record<string, unknown> | null;

  // Social & Contact
  socialLinks: StoreSocialLinks;
  email?: string;
  phone?: string;
  phoneAr?: string;
  whatsapp?: string;
  address?: string;
  addressAr?: string;

  // Announcement
  announcementBar?: AnnouncementBar;

  // SEO
  metaTitle?: string;
  metaTitleAr?: string;
  metaDescription?: string;
  metaDescriptionAr?: string;
  ogImage?: string;
  twitterHandle?: string;
  googleSiteVerification?: string;

  // Marketing Pixels
  marketingPixels?: Record<string, unknown>;

  // PWA — set by the admin's PWA settings page. The storefront's
  // app/manifest.ts already pulls a fully-formed manifest from the API, but
  // the values are mirrored here so app/layout.tsx can emit the matching iOS
  // meta tags (status-bar style, web-app-capable, apple-touch-icon) without
  // a second round-trip per request.
  pwaEnabled?: boolean;
  pwaSettings?: Record<string, unknown>;

  // General Settings (footer links, etc.)
  settings?: Record<string, unknown>;

  // Tax — when taxIncludedInPrice is true the storefront should label
  // prices with "Includes VAT" so customers don't expect the tax to be
  // added on top at checkout. taxEnabled is mirrored for parity.
  taxEnabled?: boolean;
  taxIncludedInPrice?: boolean;

  // Feature flags
  enabledFeatures?: string[];

  // CMS pages where the merchant has explicitly turned the storefront
  // toggle off (`isPublished=false` on the StorePage row). Footer link
  // resolution AND-merges this with the merchant's per-link toggles so a
  // disabled Privacy page automatically removes the "Privacy" link from
  // the bottom bar without the merchant having to flip both controls.
  // Slugs are bare ("privacy", "terms", "shipping", or any custom slug).
  disabledCmsSlugs?: string[];

  // Hero customization
  heroTitle?: string | null;
  heroTitleAr?: string | null;
  heroSubtitle?: string | null;
  heroSubtitleAr?: string | null;
  heroCtaText?: string | null;
  heroCtaTextAr?: string | null;
  heroCtaLink?: string | null;
  heroImage?: string | null;
}

/**
 * Default store used as a last-resort fallback when no real store can be
 * resolved (dev environment, edge-case paths). Production traffic on
 * `store.forcemediakw.com/` is redirected to the marketing site by the
 * middleware before this fallback is ever rendered, so customers never
 * see it. The neutral copy below is intentional — if it does slip through
 * somewhere, "Force" is harmless; "Force Demo Store" looked broken.
 */
const DEFAULT_STORE: ResolvedStore = {
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
  heroTitle: null,
  heroTitleAr: null,
  heroSubtitle: null,
  heroSubtitleAr: null,
  heroCtaText: null,
  heroCtaTextAr: null,
  heroCtaLink: null,
  heroImage: null,
};

// Simple in-memory cache for store resolution.
//
// 2 minutes (down from 5) — short enough that admin-driven changes
// (typography, Best Sellers cover, hero copy, theme, announcement
// bar) feel responsive to the merchant, long enough that we're not
// re-hitting the public store endpoint constantly and racking up
// Vercel function invocations. The API itself caches the store
// payload in Redis upstream, so the per-call cost is small either
// way, but 2 min is the sweet spot for cost vs. perceived freshness.
const storeCache = new Map<string, { store: ResolvedStore; expires: number }>();
const CACHE_TTL = 2 * 60 * 1000;

/**
 * Get the store domain from request headers
 */
export async function getStoreDomain(): Promise<string | null> {
  const headersList = await headers();
  return headersList.get('x-store-domain');
}

/**
 * Get the store slug from request headers (set by middleware on platform domains)
 */
export async function getStoreSlug(): Promise<string | null> {
  const headersList = await headers();
  return headersList.get('x-store-slug');
}

/**
 * Check if running on platform domain
 */
export async function isPlatformDomain(): Promise<boolean> {
  const headersList = await headers();
  return headersList.get('x-is-platform') === 'true';
}

/**
 * Fetch store from API by domain
 */
async function fetchStoreByDomain(domain: string): Promise<ResolvedStore | null> {
  try {
    const response = await fetch(`${API_URL}/public/store/resolve`, {
      next: { revalidate: 120 }, // 2-minute revalidate — paired with the in-memory storeCache TTL
      headers: {
        'Content-Type': 'application/json',
        'x-store-domain': domain,
      },
    });

    if (!response.ok) {
      console.error(`Failed to fetch store for domain ${domain}: ${response.status}`);
      return null;
    }

    const data = await response.json();

    if (!data.success || !data.data?.store) {
      return null;
    }

    const storeData = data.data.store;
    const enabledFeatures: string[] | undefined = Array.isArray(data.data.enabledFeatures)
      ? data.data.enabledFeatures
      : undefined;
    const disabledCmsSlugs: string[] | undefined = Array.isArray(data.data.disabledCmsSlugs)
      ? data.data.disabledCmsSlugs.filter((s: unknown): s is string => typeof s === 'string')
      : undefined;

    // Merge theme with template defaults
    const templateTheme = getTemplateTheme(storeData.template || 'modern');
    const customTheme = typeof storeData.theme === 'object' ? storeData.theme : {};

    return {
      id: storeData.id,
      name: storeData.name,
      nameAr: storeData.nameAr,
      slug: storeData.slug,
      domain: storeData.domain,
      status: storeData.status === 'suspended' ? 'suspended' : 'active',
      logo: storeData.logo,
      logoAr: storeData.logoAr,
      favicon: storeData.favicon,
      description: storeData.description,
      descriptionAr: storeData.descriptionAr,
      currency: storeData.currency || 'KWD',
      timezone: storeData.timezone || 'Asia/Kuwait',
      template: storeData.template || 'modern',
      theme: { ...templateTheme, ...customTheme },
      socialLinks: typeof storeData.socialLinks === 'object' ? storeData.socialLinks : {},
      email: storeData.email,
      phone: storeData.phone,
      phoneAr: storeData.phoneAr,
      whatsapp: storeData.whatsapp,
      address: storeData.address,
      addressAr: storeData.addressAr,
      announcementBar:
        typeof storeData.announcementBar === 'object' ? storeData.announcementBar : undefined,
      metaTitle: storeData.metaTitle,
      metaTitleAr: storeData.metaTitleAr,
      metaDescription: storeData.metaDescription,
      metaDescriptionAr: storeData.metaDescriptionAr,
      ogImage: storeData.ogImage,
      twitterHandle: storeData.twitterHandle,
      googleSiteVerification: storeData.googleSiteVerification,
      marketingPixels:
        typeof storeData.marketingPixels === 'object' ? storeData.marketingPixels : undefined,
      pwaEnabled: typeof storeData.pwaEnabled === 'boolean' ? storeData.pwaEnabled : undefined,
      pwaSettings:
        storeData.pwaSettings &&
        typeof storeData.pwaSettings === 'object' &&
        !Array.isArray(storeData.pwaSettings)
          ? (storeData.pwaSettings as Record<string, unknown>)
          : undefined,
      settings: typeof storeData.settings === 'object' ? storeData.settings : undefined,
      taxEnabled: typeof storeData.taxEnabled === 'boolean' ? storeData.taxEnabled : undefined,
      taxIncludedInPrice:
        typeof storeData.taxIncludedInPrice === 'boolean'
          ? storeData.taxIncludedInPrice
          : undefined,
      enabledFeatures,
      disabledCmsSlugs,
      heroTitle: storeData.heroTitle ?? null,
      heroTitleAr: storeData.heroTitleAr ?? null,
      heroSubtitle: storeData.heroSubtitle ?? null,
      heroSubtitleAr: storeData.heroSubtitleAr ?? null,
      heroCtaText: storeData.heroCtaText ?? null,
      heroCtaTextAr: storeData.heroCtaTextAr ?? null,
      heroCtaLink: storeData.heroCtaLink ?? null,
      heroImage: storeData.heroImage ?? null,
      // Per-store typography overrides — passed through verbatim;
      // layout.tsx sanitises every value before injecting CSS.
      typography:
        storeData.typography && typeof storeData.typography === 'object'
          ? (storeData.typography as Record<string, unknown>)
          : null,
    };
  } catch (error) {
    console.error(`Error fetching store for domain ${domain}:`, error);
    return null;
  }
}

/**
 * Resolve store from cache or API
 */
async function resolveStoreByDomain(domain: string): Promise<ResolvedStore | null> {
  // Check cache
  const cached = storeCache.get(domain);
  if (cached && cached.expires > Date.now()) {
    return cached.store;
  }

  // Fetch from API
  const store = await fetchStoreByDomain(domain);

  if (store) {
    // Cache the result
    storeCache.set(domain, {
      store,
      expires: Date.now() + CACHE_TTL,
    });
  }

  return store;
}

/**
 * Fetch store from API by slug
 */
async function fetchStoreBySlug(slug: string): Promise<ResolvedStore | null> {
  try {
    const response = await fetch(`${API_URL}/public/stores/${slug}`, {
      next: { revalidate: 120 },
      headers: { 'Content-Type': 'application/json' },
    });

    if (!response.ok) {
      console.error(`Failed to fetch store for slug ${slug}: ${response.status}`);
      return null;
    }

    const data = await response.json();

    if (!data.success || !data.data?.store) {
      return null;
    }

    const storeData = data.data.store;
    const enabledFeatures: string[] | undefined = Array.isArray(data.data.enabledFeatures)
      ? data.data.enabledFeatures
      : undefined;
    const disabledCmsSlugs: string[] | undefined = Array.isArray(data.data.disabledCmsSlugs)
      ? data.data.disabledCmsSlugs.filter((s: unknown): s is string => typeof s === 'string')
      : undefined;
    const templateTheme = getTemplateTheme(storeData.template || 'modern');
    const customTheme = typeof storeData.theme === 'object' ? storeData.theme : {};

    return {
      id: storeData.id,
      name: storeData.name,
      nameAr: storeData.nameAr,
      slug: storeData.slug,
      domain: storeData.domain,
      status: storeData.status === 'suspended' ? 'suspended' : 'active',
      logo: storeData.logo,
      logoAr: storeData.logoAr,
      favicon: storeData.favicon,
      description: storeData.description,
      descriptionAr: storeData.descriptionAr,
      currency: storeData.currency || 'KWD',
      timezone: storeData.timezone || 'Asia/Kuwait',
      template: storeData.template || 'modern',
      theme: { ...templateTheme, ...customTheme },
      socialLinks: typeof storeData.socialLinks === 'object' ? storeData.socialLinks : {},
      email: storeData.email,
      phone: storeData.phone,
      phoneAr: storeData.phoneAr,
      whatsapp: storeData.whatsapp,
      address: storeData.address,
      addressAr: storeData.addressAr,
      announcementBar:
        typeof storeData.announcementBar === 'object' ? storeData.announcementBar : undefined,
      metaTitle: storeData.metaTitle,
      metaTitleAr: storeData.metaTitleAr,
      metaDescription: storeData.metaDescription,
      metaDescriptionAr: storeData.metaDescriptionAr,
      ogImage: storeData.ogImage,
      twitterHandle: storeData.twitterHandle,
      googleSiteVerification: storeData.googleSiteVerification,
      marketingPixels:
        typeof storeData.marketingPixels === 'object' ? storeData.marketingPixels : undefined,
      pwaEnabled: typeof storeData.pwaEnabled === 'boolean' ? storeData.pwaEnabled : undefined,
      pwaSettings:
        storeData.pwaSettings &&
        typeof storeData.pwaSettings === 'object' &&
        !Array.isArray(storeData.pwaSettings)
          ? (storeData.pwaSettings as Record<string, unknown>)
          : undefined,
      settings: typeof storeData.settings === 'object' ? storeData.settings : undefined,
      taxEnabled: typeof storeData.taxEnabled === 'boolean' ? storeData.taxEnabled : undefined,
      taxIncludedInPrice:
        typeof storeData.taxIncludedInPrice === 'boolean'
          ? storeData.taxIncludedInPrice
          : undefined,
      enabledFeatures,
      disabledCmsSlugs,
      heroTitle: storeData.heroTitle ?? null,
      heroTitleAr: storeData.heroTitleAr ?? null,
      heroSubtitle: storeData.heroSubtitle ?? null,
      heroSubtitleAr: storeData.heroSubtitleAr ?? null,
      heroCtaText: storeData.heroCtaText ?? null,
      heroCtaTextAr: storeData.heroCtaTextAr ?? null,
      heroCtaLink: storeData.heroCtaLink ?? null,
      heroImage: storeData.heroImage ?? null,
      // Per-store typography overrides — passed through verbatim;
      // layout.tsx sanitises every value before injecting CSS.
      typography:
        storeData.typography && typeof storeData.typography === 'object'
          ? (storeData.typography as Record<string, unknown>)
          : null,
    };
  } catch (error) {
    console.error(`Error fetching store for slug ${slug}:`, error);
    return null;
  }
}

/**
 * Resolve store by slug from cache or API
 */
async function resolveStoreBySlug(slug: string): Promise<ResolvedStore | null> {
  const cacheKey = `slug:${slug}`;
  const cached = storeCache.get(cacheKey);
  if (cached && cached.expires > Date.now()) {
    return cached.store;
  }

  const store = await fetchStoreBySlug(slug);

  if (store) {
    storeCache.set(cacheKey, {
      store,
      expires: Date.now() + CACHE_TTL,
    });
  }

  return store;
}

/**
 * Get the current store based on request context
 * This is the main function to use in server components
 *
 * Resolution order:
 * 1. Custom domain (x-store-domain header)
 * 2. Store slug in URL path (x-store-slug header)
 * 3. Default demo store
 */
export async function getStore(): Promise<ResolvedStore> {
  // 1. Custom domain resolution
  const domain = await getStoreDomain();
  if (domain) {
    const store = await resolveStoreByDomain(domain);
    if (store) return store;
    return DEFAULT_STORE;
  }

  // 2. Slug-based resolution (platform domains)
  const slug = await getStoreSlug();
  if (slug) {
    const store = await resolveStoreBySlug(slug);
    if (store) return store;
    return DEFAULT_STORE;
  }

  // 3. Default demo store
  return DEFAULT_STORE;
}

/**
 * Server-component variant of {@link getStore} that triggers Next's
 * `notFound()` when a store identifier was provided in the request but
 * doesn't match any active store (custom domain not registered, or
 * platform-path slug like `/haha` that no merchant owns).
 *
 * Pages that depend on a real store (homepage, /products, /categories,
 * etc.) should use this so unknown slugs land on the branded
 * `not-found.tsx` instead of silently rendering the empty `Force` demo
 * storefront — the latter looked broken to customers and made
 * "is this typo a real shop?" investigations harder for support.
 *
 * The layout itself still uses the lenient `getStore()` because the
 * not-found page renders inside that layout and needs the
 * `DEFAULT_STORE` chrome (Force-branded header/footer) to render
 * without crashing.
 */
export async function getStoreOrNotFound(): Promise<ResolvedStore> {
  const domain = await getStoreDomain();
  if (domain) {
    const store = await resolveStoreByDomain(domain);
    if (!store) notFound();
    return store;
  }

  const slug = await getStoreSlug();
  if (slug) {
    const store = await resolveStoreBySlug(slug);
    if (!store) notFound();
    return store;
  }

  // No identifier in the request at all — bare-root on a platform
  // domain. Middleware redirects this to forcemediakw.com in
  // production, so reaching here means localhost or a preview
  // deploy; render the default chrome rather than 404.
  return DEFAULT_STORE;
}

/**
 * Get store by ID (for admin panel)
 */
export async function getStoreById(storeId: string): Promise<ResolvedStore | null> {
  try {
    const response = await fetch(`${API_URL}/stores/${storeId}`, {
      next: { revalidate: 60 },
      headers: {
        'Content-Type': 'application/json',
      },
    });

    if (!response.ok) {
      return null;
    }

    const data = await response.json();

    if (!data.success || !data.data?.store) {
      return null;
    }

    const storeData = data.data.store;
    const templateTheme = getTemplateTheme(storeData.template || 'modern');
    const customTheme = typeof storeData.theme === 'object' ? storeData.theme : {};

    return {
      id: storeData.id,
      name: storeData.name,
      nameAr: storeData.nameAr,
      slug: storeData.slug,
      domain: storeData.domain,
      status: storeData.status === 'suspended' ? 'suspended' : 'active',
      logo: storeData.logo,
      logoAr: storeData.logoAr,
      favicon: storeData.favicon,
      description: storeData.description,
      descriptionAr: storeData.descriptionAr,
      currency: storeData.currency || 'KWD',
      timezone: storeData.timezone || 'Asia/Kuwait',
      template: storeData.template || 'modern',
      theme: { ...templateTheme, ...customTheme },
      socialLinks: typeof storeData.socialLinks === 'object' ? storeData.socialLinks : {},
      email: storeData.email,
      phone: storeData.phone,
      phoneAr: storeData.phoneAr,
      whatsapp: storeData.whatsapp,
      address: storeData.address,
      addressAr: storeData.addressAr,
      announcementBar:
        typeof storeData.announcementBar === 'object' ? storeData.announcementBar : undefined,
      metaTitle: storeData.metaTitle,
      metaTitleAr: storeData.metaTitleAr,
      metaDescription: storeData.metaDescription,
      metaDescriptionAr: storeData.metaDescriptionAr,
      ogImage: storeData.ogImage,
      twitterHandle: storeData.twitterHandle,
      googleSiteVerification: storeData.googleSiteVerification,
      marketingPixels:
        typeof storeData.marketingPixels === 'object' ? storeData.marketingPixels : undefined,
      pwaEnabled: typeof storeData.pwaEnabled === 'boolean' ? storeData.pwaEnabled : undefined,
      pwaSettings:
        storeData.pwaSettings &&
        typeof storeData.pwaSettings === 'object' &&
        !Array.isArray(storeData.pwaSettings)
          ? (storeData.pwaSettings as Record<string, unknown>)
          : undefined,
      settings: typeof storeData.settings === 'object' ? storeData.settings : undefined,
      taxEnabled: typeof storeData.taxEnabled === 'boolean' ? storeData.taxEnabled : undefined,
      taxIncludedInPrice:
        typeof storeData.taxIncludedInPrice === 'boolean'
          ? storeData.taxIncludedInPrice
          : undefined,
      heroTitle: storeData.heroTitle ?? null,
      heroTitleAr: storeData.heroTitleAr ?? null,
      heroSubtitle: storeData.heroSubtitle ?? null,
      heroSubtitleAr: storeData.heroSubtitleAr ?? null,
      heroCtaText: storeData.heroCtaText ?? null,
      heroCtaTextAr: storeData.heroCtaTextAr ?? null,
      heroCtaLink: storeData.heroCtaLink ?? null,
      heroImage: storeData.heroImage ?? null,
      // Per-store typography overrides — passed through verbatim;
      // layout.tsx sanitises every value before injecting CSS.
      typography:
        storeData.typography && typeof storeData.typography === 'object'
          ? (storeData.typography as Record<string, unknown>)
          : null,
    };
  } catch (error) {
    console.error(`Error fetching store ${storeId}:`, error);
    return null;
  }
}

/**
 * Clear store cache (useful for updates)
 */
export function clearStoreCache(domain?: string): void {
  if (domain) {
    storeCache.delete(domain);
  } else {
    storeCache.clear();
  }
}
