import { redis } from '../services/redis.service';
import { BoundedMap } from './bounded-map';
import { revalidateStorefront } from './revalidate-storefront';

/**
 * Public-route response cache. Used by the storefront-facing endpoints
 * (`/public/...`) to dedupe DB hits across hot reads (store lookup,
 * category list, product list). Two layers:
 *
 *   - Redis (`cache:<key>` namespace) — primary store, survives across
 *     pods and ttls naturally
 *   - In-memory `BoundedMap` — fallback when Redis is unavailable;
 *     bounded to 1000 entries with LRU-style eviction so a stream of
 *     unique keys (e.g. bot scans) can't OOM the API
 *
 * Read path (`getCached`) tries Redis first, falls back to memory,
 * and on miss invokes the fetcher and writes through to both. Write
 * paths in the rest of the codebase MUST call `invalidateCached` after
 * mutations or the storefront serves stale data for up to the TTL.
 *
 * Lives in `lib/` rather than `routes/public.routes.ts` so services
 * (which can't import from `routes/`) can bust caches at write time
 * without circular dependencies.
 */
const memoryCache = new BoundedMap<string, { data: unknown; expiresAt: number }>(1000);

/**
 * In-process single-flight registry. When both cache layers miss, concurrent
 * requests for the SAME key share one in-flight `fetchFn()` instead of each
 * hammering the DB — collapsing a per-pod thundering herd at every TTL boundary
 * (e.g. a hot category page) down to one query + N cache hits. Cross-pod, the
 * herd is at most (pod count), not (request count).
 */
const inFlight = new Map<string, Promise<unknown>>();

export async function getCached<T>(
  key: string,
  ttlSeconds: number,
  fetchFn: () => Promise<T>
): Promise<T> {
  try {
    const cached = await redis.get<string>(key);
    if (cached) {
      return typeof cached === 'string' ? JSON.parse(cached) : (cached as T);
    }
  } catch {
    // Redis unavailable, fall through.
  }

  const memEntry = memoryCache.get(key);
  if (memEntry && memEntry.expiresAt > Date.now()) {
    return memEntry.data as T;
  }

  // Miss on both layers: single-flight the fetch so concurrent callers for this
  // key don't each run fetchFn(). A late waiter that arrives after the fetch
  // resolved will re-read the now-warm cache on its next call.
  const existing = inFlight.get(key) as Promise<T> | undefined;
  if (existing) return existing;

  const pending = (async () => {
    const data = await fetchFn();
    try {
      await redis.set(key, JSON.stringify(data), ttlSeconds);
    } catch {
      // Redis unavailable, memory cache below is the fallback.
    }
    memoryCache.set(key, { data, expiresAt: Date.now() + ttlSeconds * 1000 });
    return data;
  })();

  inFlight.set(key, pending);
  try {
    return await pending;
  } finally {
    inFlight.delete(key);
  }
}

/**
 * Invalidate a cached entry from BOTH Redis and the in-memory fallback.
 * Without this, a write on the admin side leaves the storefront
 * serving stale rows until the TTL expires (60s for store, 120s for
 * categories, 30s for product lists). Call from every write path that
 * mutates the underlying data.
 */
export async function invalidateCached(key: string): Promise<void> {
  try {
    await redis.delete(key);
  } catch {
    // Redis unavailable — memory delete still runs below.
  }
  memoryCache.delete(key);
}

/**
 * Bulk invalidator. Drops every entry starting with `prefix` from BOTH the
 * in-memory fallback AND Redis (via a non-blocking SCAN+UNLINK). Previously
 * this only swept the in-memory layer and let Redis expire on TTL, which meant
 * a price/stock correction stayed live on OTHER API replicas (and the same pod
 * after a restart) for up to the TTL — the Redis copy outlived the bust. Now
 * both layers clear immediately. Best-effort on the Redis side: an outage is
 * swallowed and the in-memory sweep still runs.
 */
export async function invalidateCachedPrefix(prefix: string): Promise<void> {
  for (const key of memoryCache.keys()) {
    if (key.startsWith(prefix)) memoryCache.delete(key);
  }
  try {
    await redis.deleteByPattern(prefix);
  } catch {
    // Redis unavailable — in-memory sweep above already ran.
  }
}

/**
 * Bust the public AND admin category-list caches for a store (both cache
 * layers). Mirrors `invalidateStoreProductCaches`'s reasoning: folding the
 * admin prefix into the same call means every existing `public:categories`
 * invalidation call site (category.routes.ts, store.service.ts,
 * product.service.ts, the bulk-import/bulk-AI Inngest functions) covers the
 * admin category-list cache too, with no second call site to thread through.
 */
export async function invalidateStoreCategoriesCaches(storeId: string): Promise<void> {
  await invalidateCached(`public:categories:${storeId}`);
  await invalidateCached(`admin:categories:${storeId}`);
  // Same reasoning as invalidateStoreProductCaches: the storefront holds the
  // API's response in the Next data cache, so Redis alone is not enough.
  revalidateStorefront({ tags: [`categories:${storeId}`] });
}

/**
 * Bust every product-facing cache for a store (both layers) — public
 * (storefront) AND admin. The product LIST, per-product DETAIL, and search
 * SUGGEST caches all carry `price` and `inventory`/`inStock`, so ANY write
 * that changes a product's price or stock MUST call this — admin edits (via
 * `ProductService`) AND checkout-driven inventory decrement/restore (via
 * `OrderService`). Kept here in the shared lib so both services reuse one
 * key definition without a circular import.
 *
 * `admin:products:${storeId}:` was added alongside the admin product-list
 * cache (`product.routes.ts` GET /) — every one of the many call sites below
 * already busts the public prefixes on every Product write, so folding the
 * admin prefix into this SAME function means the admin list cache is
 * automatically covered by every existing (and future) call site instead of
 * requiring a second invalidation call to be threaded through the whole
 * Product write surface a second time.
 *
 * Also busts the category caches: the admin category list's `_count.products`
 * (category.routes.ts GET /) is derived from live Product rows (status,
 * deletedAt), so ANY product write that changes those — including a bulk
 * delete/status update that doesn't touch a single Category row — can make
 * the cached category counts stale. Folding it in here (rather than auditing
 * every product-write call site a second time for this dependency) is the
 * safe default: it costs two extra single-key deletes, not a scan.
 */
export async function invalidateStoreProductCaches(storeId: string): Promise<void> {
  await invalidateCachedPrefix(`public:products:${storeId}:`);
  await invalidateCachedPrefix(`public:product:${storeId}:`);
  await invalidateCachedPrefix(`public:suggest:${storeId}:`);
  await invalidateCachedPrefix(`admin:products:${storeId}:`);
  await invalidateStoreCategoriesCaches(storeId);

  // Clearing Redis is only half the job. The Next.js storefront caches the
  // API's RESPONSE in its own data cache, so after a save the merchant kept
  // seeing the old product until that window expired — which is why saving
  // twice "worked": the second save just took long enough. Every storefront
  // product fetch is tagged `products:<storeId>`; purge it here, at the one
  // place every writer already funnels through, so no call site can forget.
  // Fire-and-forget by design (see revalidate-storefront) — a storefront blip
  // must never fail a save that already committed.
  revalidateStorefront({ tags: [`products:${storeId}`] });
}

/** Cache key for the admin aggregated-customers snapshot (`customers.routes.ts`). */
export function customersCacheKey(storeId: string): string {
  return `customers-agg:${storeId}`;
}

/**
 * Invalidate the cached aggregated-customers snapshot for a store. Lives here
 * (rather than `routes/customers.routes.ts`) so services — which can't import
 * from `routes/` (see module doc comment above) — can bust this cache from
 * order-mutation paths (status changes, payment updates, cancellations)
 * instead of waiting out the 300s TTL.
 */
export async function invalidateCustomersCache(storeId: string): Promise<void> {
  await invalidateCached(customersCacheKey(storeId));
}
