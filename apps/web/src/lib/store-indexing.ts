import { hidesFromSearch } from './hide-from-search';

/**
 * What a crawler may be told about a store host, from the one `/public/store/resolve` answer (Ruling ROBOTS-CLOSED-1).
 *
 *  - `open`   : an active store: robots allows, the sitemap lists it.
 *  - `hidden` : the demo showroom or a store the merchant hid: crawlable (so its own `noindex` meta is read), no sitemap.
 *  - `closed` : a host with no live storefront: the resolver 404s it (unknown, inactive/archived, soft-deleted) or it is
 *               suspended (the branded maintenance page). robots.txt is `Disallow: /` with no sitemap, sitemap.xml is a 404.
 *  - `unknown`: the resolver could not be asked (5xx, network). Never `closed`: a blip must not tell crawlers to leave
 *               for the cache window, so robots keeps its open answer and the sitemap fails (5xx) instead.
 */
export type HostIndexing = 'open' | 'hidden' | 'closed' | 'unknown';

/** Store statuses that serve no indexable storefront (the resolver returns a suspended store so it can render maintenance). */
const CLOSED_STATUSES = new Set(['suspended', 'inactive', 'archived', 'draft', 'deleted']);

export function classifyResolve(
  httpStatus: number,
  store:
    | { status?: string; isDemo?: boolean; settings?: Record<string, unknown> | null }
    | null
    | undefined
): HostIndexing {
  if (httpStatus === 404) return 'closed';
  if (httpStatus < 200 || httpStatus >= 300) return 'unknown';
  if (!store) return 'unknown';
  if (store.status && CLOSED_STATUSES.has(store.status)) return 'closed';
  if (store.isDemo === true || hidesFromSearch(store)) return 'hidden';
  return 'open';
}
