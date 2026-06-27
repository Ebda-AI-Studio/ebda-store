// Storefront URL composition for admin surfaces.
//
// The storefront is path-routed under a single shared subdomain
// (`store.force-ai.co/<slug>`), NOT `<slug>.forcemediakw.com`. Six
// admin call sites previously rolled their own subdomain-style fallback;
// keep this helper as the single source of truth.

export const PLATFORM_STORE_HOST = 'store.force-ai.co';

type StoreUrlInput = { slug: string; domain?: string | null };

export function getStoreDisplayUrl(store: StoreUrlInput): string {
  return store.domain || `${PLATFORM_STORE_HOST}/${store.slug}`;
}

export function getPlatformStoreUrl(slug: string): string {
  return `${PLATFORM_STORE_HOST}/${slug}`;
}

export function getStoreHref(store: StoreUrlInput): string {
  if (store.domain) return `https://${store.domain}`;
  const base = process.env.NEXT_PUBLIC_WEB_URL ?? `https://${PLATFORM_STORE_HOST}`;
  return `${base}/${store.slug}`;
}
