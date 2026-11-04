import { DbClient, Prisma, SlugEntityType, prisma } from '@ebda/database';
import { AppError } from '../middleware/error-handler';
import { BoundedMap } from '../lib/bounded-map';
import { storeWritesToDo } from '../lib/repo-factory';
import { requirePlatformDb } from '../lib/platform-db';

/**
 * Where a store's SlugRedirect rows live: the platform D1 for a store served by its Durable Object (the model is `target: d1`
 * in model-split.json), the Postgres `prisma` proxy for every other store (unchanged). Never a Postgres fallback for a DO store.
 */
async function slugRedirectDb(
  storeId: string
): Promise<{ slugRedirect: typeof prisma.slugRedirect }> {
  if (await storeWritesToDo(storeId)) return (await requirePlatformDb()) as never;
  return prisma;
}

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
    const row = await (
      await slugRedirectDb(storeId)
    ).slugRedirect.findUnique({
      where: { storeId_entityType_fromSlug: { storeId, entityType, fromSlug: current } },
    });
    if (!row) return current === slug ? null : current;
    if (row.toSlug === current) return current; // self-loop guard
    current = row.toSlug;
  }
  return current;
}

/** Rows returned per list request, and the most a caller may ask for. */
export const SLUG_REDIRECT_LIST_LIMIT = 200;
export const SLUG_REDIRECT_LIST_MAX = 500;

/**
 * List a store's redirects, newest first, capped — this table has no admin
 * UI other than this list (#903), so it is read-only apart from the delete
 * below; there is no create/edit path because rows are written exclusively
 * by `recordSlugRedirect` alongside the entity rename that produced them.
 *
 * Returns the TOTAL alongside the capped page (scoped audit, PR 1978): a bulk
 * import writes hundreds of rows at once, and a silently-capped list reads as
 * "that redirect does not exist" to a merchant hunting an older one. `q`
 * narrows by a case-insensitive substring of either slug so a row past the
 * cap is still findable.
 */
export async function listSlugRedirects(
  storeId: string,
  opts: { q?: string; limit?: number; cursor?: string } = {}
) {
  const limit = Math.min(opts.limit ?? SLUG_REDIRECT_LIST_LIMIT, SLUG_REDIRECT_LIST_MAX);
  const q = opts.q?.trim();
  const where: Prisma.SlugRedirectWhereInput = {
    storeId,
    ...(q
      ? {
          OR: [
            { fromSlug: { contains: q, mode: 'insensitive' } },
            { toSlug: { contains: q, mode: 'insensitive' } },
          ],
        }
      : {}),
  };
  // Sequential, not Promise.all: inside the request's tenant transaction both
  // run on one connection anyway.
  //
  // Cursor-paged (issue 2255): every row is reachable by browsing, not only by
  // searching for a slug the merchant already knows. `id` breaks `createdAt`
  // ties so a bulk import's rows (one timestamp) page stably. One row past
  // the page is fetched to know whether another page exists.
  const sdb = await slugRedirectDb(storeId);
  const fetched = await sdb.slugRedirect.findMany({
    where,
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: limit + 1,
    ...(opts.cursor ? { cursor: { id: opts.cursor }, skip: 1 } : {}),
  });
  const rows = fetched.slice(0, limit);
  const nextCursor = fetched.length > limit ? rows[rows.length - 1].id : null;
  const total = await sdb.slugRedirect.count({ where });
  return { rows, total, limit, nextCursor };
}

/**
 * Delete one redirect row, scoped to the caller's store so a merchant can
 * never delete another tenant's row by guessing an id (#903). Used for a
 * spuriously-captured bulk-import alias, or when an old slug is being
 * re-purposed for something new and the stale redirect would otherwise win.
 */
export async function deleteSlugRedirect(storeId: string, id: string): Promise<void> {
  const { count } = await (
    await slugRedirectDb(storeId)
  ).slugRedirect.deleteMany({ where: { id, storeId } });
  if (count === 0) {
    throw new AppError(404, 'NOT_FOUND', 'Slug redirect not found');
  }
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
 * pre-redirect behaviour). Symmetrically, a row removed by `deleteSlugRedirect`
 * keeps resolving for up to the same window on each instance (a per-instance
 * map cannot be invalidated across instances). A slug that is live again never
 * reaches this path — the storefront only asks after its own product lookup missed. In-memory
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
