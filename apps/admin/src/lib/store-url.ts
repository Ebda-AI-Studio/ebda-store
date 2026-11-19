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

type StoreUrlInput = { slug: string; domain?: string | null; domainStatus?: string | null };

/**
 * The custom domain only when it is LIVE (STORE-QA-23). A claim that is 'pending' or 'failed' resolves to nothing yet, so a
 * link, a copied store URL or a printed QR built from it is dead until DNS verifies; those fall back to `<slug>.ebda.app`.
 * `domainStatus` null/undefined = a legacy verified domain (kept live).
 */
export function liveDomain(store: {
  domain?: string | null;
  domainStatus?: string | null;
}): string | null {
  if (!store.domain) return null;
  return store.domainStatus === 'pending' || store.domainStatus === 'failed' ? null : store.domain;
}

/** Display host for a store: its custom domain, else `<slug>.ebda.app`. */
export function getStoreDisplayUrl(store: StoreUrlInput): string {
  return liveDomain(store) || storeHost(store.slug);
}

/** The free `<slug>.ebda.app` host for a slug (display form, no scheme). */
export function getPlatformStoreUrl(slug: string): string {
  return storeHost(slug);
}

/** Absolute storefront URL: `https://<custom-domain>` or `https://<slug>.ebda.app`. */
export function getStoreHref(store: StoreUrlInput): string {
  return storefrontOrigin({ slug: store.slug, domain: liveDomain(store) });
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
