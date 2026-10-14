import { parseStoreHost, storeHost } from '@ebda/shared';

/**
 * How a request `Host` maps to a store row — the API half of Ebda's host
 * routing (program plan §1, design cloudflare-backend §4):
 *
 *   `<slug>.ebda.app`  → look the store up by SLUG
 *   anything else      → look it up by VERIFIED custom DOMAIN
 *   reserved / platform / IP / localhost / malformed → no lookup at all (404)
 *
 * There is deliberately NO "default store" outcome: `null` means the caller
 * answers 404 (or 400 `STORE_NOT_RESOLVED` on the id-resolving helpers), never
 * "the first store".
 */
export type StoreHostLookup =
  | { by: 'slug'; slug: string; cacheHost: string }
  | { by: 'domain'; domain: string; cacheHost: string };

export function storeLookupForHost(rawHost: string | null | undefined): StoreHostLookup | null {
  const parsed = parseStoreHost(rawHost);
  if (parsed.kind === 'subdomain') {
    return { by: 'slug', slug: parsed.slug, cacheHost: storeHost(parsed.slug) };
  }
  if (parsed.kind === 'custom') {
    // Custom domains are stored apex-normalised (the storefront 301s www → apex),
    // so a `www.` request resolves to the same row as the bare domain.
    const domain = parsed.hostname.replace(/^www\./, '');
    return { by: 'domain', domain, cacheHost: domain };
  }
  return null;
}

/** Prisma `where` fragment selecting the store a host belongs to, or `null`. */
export function storeWhereForHost(
  rawHost: string | null | undefined
): { slug: string } | { domain: string; domainStatus: 'active' } | null {
  const lookup = storeLookupForHost(rawHost);
  if (!lookup) return null;
  return lookup.by === 'slug' ? { slug: lookup.slug } : storeDomainWhere(lookup.domain);
}

/**
 * The ONLY `where` that may select a store by custom domain: the domain must be
 * VERIFIED (`domainStatus: 'active'`). An unverified claim lives in
 * `pendingDomain` and never matches here, so a squatter's claim of someone
 * else's domain can neither resolve a storefront nor be CORS-trusted
 * (SP5 task 4). Every domain -> store lookup goes through this.
 */
export function storeDomainWhere(domain: string): { domain: string; domainStatus: 'active' } {
  return { domain, domainStatus: 'active' };
}
