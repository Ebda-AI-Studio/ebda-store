// Storefront URL composition for admin surfaces.
//
// Every store is served at its own host: `<slug>.ebda.app` (free), plus an
// optional merchant custom domain. There is NO path-based `/<slug>` store URL
// on the apex. This module is the single place admin code turns a store into a
// URL/display host — it delegates to the shared brand helpers so the format
// can never drift from the storefront's own host routing.
import { BRAND, storeHost, storefrontOrigin } from '@ebda/shared';

/** The suffix the free store address ends with, e.g. `.ebda.app`. */
export const STORE_HOST_SUFFIX: string = BRAND.domains.storeSuffix;

type StoreUrlInput = { slug: string; domain?: string | null };

/** Display host for a store: its custom domain, else `<slug>.ebda.app`. */
export function getStoreDisplayUrl(store: StoreUrlInput): string {
  return store.domain || storeHost(store.slug);
}

/** The free `<slug>.ebda.app` host for a slug (display form, no scheme). */
export function getPlatformStoreUrl(slug: string): string {
  return storeHost(slug);
}

/** Absolute storefront URL: `https://<custom-domain>` or `https://<slug>.ebda.app`. */
export function getStoreHref(store: StoreUrlInput): string {
  return storefrontOrigin(store);
}
