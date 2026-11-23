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

/**
 * Host a visitor really lands on, for previews: the custom domain once it is
 * verified, otherwise the free `<slug>.ebda.app` address. `domainVerifiedAt`
 * explicitly `null` means the domain is not live yet; absent means the payload
 * does not carry it, so the stored domain is trusted.
 */
export function getStorePublicHost(
  store: StoreUrlInput & { domainVerifiedAt?: string | null }
): string {
  const domain = store.domain?.trim().toLowerCase();
  if (domain && store.domainVerifiedAt !== null) return domain;
  return storeHost(store.slug);
}

/** The free `<slug>.ebda.app` host for a slug (display form, no scheme). */
export function getPlatformStoreUrl(slug: string): string {
  return storeHost(slug);
}

/** Absolute storefront URL: `https://<custom-domain>` or `https://<slug>.ebda.app`. */
export function getStoreHref(store: StoreUrlInput): string {
  return storefrontOrigin(store);
}

/**
 * The origin the editor's preview frame loads: ALWAYS `https://<slug>.ebda.app`, never the custom domain. Every
 * store has that origin, the admin's frame-src allows `https://*.ebda.app` on every route, and it keeps the
 * postMessage origin check pinned to one known host whatever the merchant's domain does (Controller design note
 * 2026-11-15; the web middleware does not redirect a slug host to a custom domain: `routeByHost` serves
 * `subdomain` hosts directly).
 */
export function getBuilderPreviewOrigin(store: { slug: string }): string {
  return storefrontOrigin({ slug: store.slug });
}
