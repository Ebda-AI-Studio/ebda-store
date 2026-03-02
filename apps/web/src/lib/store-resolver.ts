import { headers } from 'next/headers';
import {
  type StoreTheme,
  type StoreSocialLinks,
  type AnnouncementBar,
  type TemplateId,
  DEFAULT_THEME,
  getTemplateTheme,
} from '@force/shared';

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000/api/v1';

/**
 * Resolved store configuration
 */
export interface ResolvedStore {
  id: string;
  name: string;
  nameAr?: string;
  slug: string;
  domain?: string;
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

  // Marketing Pixels
  marketingPixels?: Record<string, unknown>;

  // General Settings (footer links, etc.)
  settings?: Record<string, unknown>;
}

/**
 * Default store for platform/demo mode
 */
const DEFAULT_STORE: ResolvedStore = {
  id: 'demo',
  name: 'Force Demo Store',
  nameAr: 'متجر فورس التجريبي',
  slug: 'demo',
  currency: 'KWD',
  timezone: 'Asia/Kuwait',
  template: 'modern',
  theme: DEFAULT_THEME,
  socialLinks: {},
};

// Simple in-memory cache for store resolution
const storeCache = new Map<string, { store: ResolvedStore; expires: number }>();
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

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
      next: { revalidate: 300 }, // Revalidate every 5 minutes
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

    // Merge theme with template defaults
    const templateTheme = getTemplateTheme(storeData.template || 'modern');
    const customTheme = typeof storeData.theme === 'object' ? storeData.theme : {};

    return {
      id: storeData.id,
      name: storeData.name,
      nameAr: storeData.nameAr,
      slug: storeData.slug,
      domain: storeData.domain,
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
      marketingPixels:
        typeof storeData.marketingPixels === 'object' ? storeData.marketingPixels : undefined,
      settings: typeof storeData.settings === 'object' ? storeData.settings : undefined,
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
      next: { revalidate: 300 },
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
    const templateTheme = getTemplateTheme(storeData.template || 'modern');
    const customTheme = typeof storeData.theme === 'object' ? storeData.theme : {};

    return {
      id: storeData.id,
      name: storeData.name,
      nameAr: storeData.nameAr,
      slug: storeData.slug,
      domain: storeData.domain,
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
      marketingPixels:
        typeof storeData.marketingPixels === 'object' ? storeData.marketingPixels : undefined,
      settings: typeof storeData.settings === 'object' ? storeData.settings : undefined,
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
    console.warn(`Store not found for domain: ${domain}`);
    return DEFAULT_STORE;
  }

  // 2. Slug-based resolution (platform domains)
  const slug = await getStoreSlug();
  if (slug) {
    const store = await resolveStoreBySlug(slug);
    if (store) return store;
    console.warn(`Store not found for slug: ${slug}`);
    return DEFAULT_STORE;
  }

  // 3. Default demo store
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
      marketingPixels:
        typeof storeData.marketingPixels === 'object' ? storeData.marketingPixels : undefined,
      settings: typeof storeData.settings === 'object' ? storeData.settings : undefined,
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
