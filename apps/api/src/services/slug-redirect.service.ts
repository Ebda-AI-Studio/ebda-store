import { DbClient, SlugEntityType, prisma } from '@force/database';
import { BoundedMap } from '../lib/bounded-map';

/**
 * Record a slug rename so the old URL 301s to the new one.
 * Call inside the same transaction as the entity write. Ordering matters:
 * reuse-guard, then chain-collapse, then upsert.
 */
export async function recordSlugRedirect(
  tx: DbClient,
  storeId: string,
  entityType: SlugEntityType,
  oldSlug: string,
  newSlug: string
): Promise<void> {
  if (!oldSlug || !newSlug || oldSlug === newSlug) return;

  // 1. Reuse guard — the new slug is live again, it must never redirect.
  await tx.slugRedirect.deleteMany({ where: { storeId, entityType, fromSlug: newSlug } });

  // 2. Chain-collapse — any redirect pointing at the old slug now points at the new one.
  await tx.slugRedirect.updateMany({
    where: { storeId, entityType, toSlug: oldSlug },
    data: { toSlug: newSlug },
  });

  // 3. Upsert old -> new.
  await tx.slugRedirect.upsert({
    where: { storeId_entityType_fromSlug: { storeId, entityType, fromSlug: oldSlug } },
    create: { storeId, entityType, fromSlug: oldSlug, toSlug: newSlug },
    update: { toSlug: newSlug },
  });
}

/**
 * Resolve a (possibly stale) slug to its current one, following the
 * SlugRedirect chain. recordSlugRedirect keeps chains collapsed to a single
 * hop, so the 3-hop cap here is purely a defensive backstop for legacy rows
 * or a self-loop, not the expected path.
 *
 * NOTE: the hop cap alone does not prevent a 2-cycle (A→B, B→A); convergence
 * instead relies on recordSlugRedirect being the sole writer — its
 * reuse-guard + chain-collapse steps prevent inverse rows from coexisting.
 *
 * Returns null when the slug was never redirected (first lookup misses);
 * otherwise the final resolved slug.
 */
export async function resolveSlugRedirect(
  storeId: string,
  entityType: SlugEntityType,
  slug: string
): Promise<string | null> {
  let current = slug;
  for (let hops = 0; hops < 3; hops++) {
    const row = await prisma.slugRedirect.findUnique({
      where: { storeId_entityType_fromSlug: { storeId, entityType, fromSlug: current } },
    });
    if (!row) return current === slug ? null : current;
    if (row.toSlug === current) return current; // self-loop guard
    current = row.toSlug;
  }
  return current;
}

/**
 * Short in-process cache in front of `resolveSlugRedirect` for the public
 * `GET /public/redirects/resolve` endpoint (#904).
 *
 * The storefront calls that endpoint on every product/blog 404, and 404s are
 * what crawlers and scanners hit in volume: up to 3 chain-walk queries per
 * miss, uncached, on an unauthenticated surface. Both answers are cached —
 * a MISS (null) is the common case and the one worth absorbing.
 *
 * Staleness class: BOUNDED. A redirect recorded by a rename becomes visible
 * within REDIRECT_CACHE_TTL_MS; until then the old slug keeps its 404 (the
 * pre-redirect behaviour). A slug that is live again never reaches this path
 * — the storefront only asks after its own product lookup missed. In-memory
 * (bounded-map), per API instance, because the Redis TTL floor is 120s.
 */
export const REDIRECT_CACHE_TTL_MS = 60_000;
const redirectCache = new BoundedMap<string, { toSlug: string | null; expiresAt: number }>(5000);

export async function resolveSlugRedirectCached(
  storeId: string,
  entityType: SlugEntityType,
  slug: string,
  now: number = Date.now()
): Promise<string | null> {
  const key = `${storeId}:${entityType}:${slug}`;
  const hit = redirectCache.get(key);
  if (hit && hit.expiresAt > now) return hit.toSlug;
  const toSlug = await resolveSlugRedirect(storeId, entityType, slug);
  redirectCache.set(key, { toSlug, expiresAt: now + REDIRECT_CACHE_TTL_MS });
  return toSlug;
}

/** Test seam: forget every cached resolution. */
export function clearSlugRedirectCache(): void {
  redirectCache.clear();
}
