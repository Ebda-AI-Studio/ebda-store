/**
 * Cached store-directory READS (NEON-SCALE-1 rule 1, Rulings NZ-D1, NEON-ZERO-3).
 *
 * `lookupStoreCached` answers slug / verified custom domain / id -> `{ id, status }` from the shared public cache
 * (`getCached`: KV_CACHE behind the strongly consistent generation counters), filling from D1 only on a miss. An unknown
 * key is cached too (`{ none: true }`), so a bot walking random slugs costs one D1 read per key per minute, not one per request.
 *
 * The cached entry is status-AGNOSTIC (every live status, soft-deleted excluded); the caller's `statuses` filter is applied
 * on the way out, so one entry serves the public (active, suspended) and preview (+ inactive) views.
 *
 * STALENESS CLASS (Ruling NZ-D1): `status`, slug and domain are NEVER-stale in intent. Event invalidation: `bustStoreCaches`
 * (services/store.service.ts, called on every write of slug / domain / status / plan / billing suspension / creation) calls
 * `invalidateStoreDirectory`. KV delete reaches other data centres within ~60 s, so on storefront READS a just-suspended
 * store may still resolve for <= 60 s. RESIDUAL, accepted: reads only. WRITE paths (cart, checkout, order, payment, account,
 * every admin route) MUST NOT use this module: they call `lookupStore` (D1 primary) or the StoreDO and refuse a suspended
 * store. A retired slug / domain (the OLD value of a change) is not known to the invalidator and expires on its TTL (60 s).
 * Cost if wrong: a suspended store's pages stay browsable for up to a minute; no sale can complete.
 */
import { getCached, invalidateCached } from './public-cache';
import { lookupStore, type StoreStatusName } from './definer';
import { isReservedSlug, storeHost } from '@ebda/shared';

/** One minute: the KV floor, and the NZ-D1 residual. Positive and negative entries share it. */
export const DIRECTORY_TTL_SECONDS = 60;

type Match = { id?: string | null; slug?: string | null; domain?: string | null };
type Entry = { id: string; status: StoreStatusName } | { none: true };

const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,62})$/;
const HOST_RE = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ALL_LIVE: readonly StoreStatusName[] = ['active', 'inactive', 'suspended'];

const keyOf = {
  id: (id: string) => `dir:id:${id}`,
  slug: (slug: string) => `dir:slug:${slug}`,
  domain: (domain: string) => `dir:domain:${domain}`,
};

/**
 * Single-key lookup (id OR slug OR domain), cached. Anything malformed, reserved, or carrying more than one key resolves
 * without touching cache or D1 (multi-key precedence stays in `lookupStore`).
 */
export async function lookupStoreCached(
  match: Match,
  statuses: readonly StoreStatusName[] = ['active']
): Promise<{ id: string; status: string } | null> {
  const keys = [match.id, match.slug, match.domain].filter(Boolean);
  if (keys.length === 0) return null;
  if (keys.length !== 1) return lookupStore(match, statuses);

  let key: string;
  let fill: Match;
  if (match.id) {
    if (!UUID_RE.test(match.id)) return null;
    key = keyOf.id(match.id);
    fill = { id: match.id };
  } else if (match.slug) {
    const slug = match.slug.toLowerCase();
    if (!SLUG_RE.test(slug) || isReservedSlug(slug)) return null;
    key = keyOf.slug(slug);
    fill = { slug };
  } else {
    const domain = match.domain!.toLowerCase();
    if (!HOST_RE.test(domain)) return null;
    key = keyOf.domain(domain);
    fill = { domain };
  }

  const entry = await getCached<Entry>(key, DIRECTORY_TTL_SECONDS, async () => {
    const hit = await lookupStore(fill, ALL_LIVE);
    return hit ? { id: hit.id, status: hit.status as StoreStatusName } : { none: true };
  });
  if ('none' in entry) return null;
  return statuses.includes(entry.status) ? { id: entry.id, status: entry.status } : null;
}

/** Drop every directory entry a store write can have changed. Called from `bustStoreCaches`. */
export async function invalidateStoreDirectory(
  storeId: string,
  slug: string | null,
  domain?: string | null
): Promise<void> {
  await invalidateCached(keyOf.id(storeId));
  if (slug) await invalidateCached(keyOf.slug(slug.toLowerCase()));
  if (slug) await invalidateCached(keyOf.domain(storeHost(slug)));
  if (domain) await invalidateCached(keyOf.domain(domain.toLowerCase()));
}
