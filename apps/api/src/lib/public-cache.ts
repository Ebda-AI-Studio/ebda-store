import { redis } from '../services/redis.service';
import { BoundedMap } from './bounded-map';

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

  const data = await fetchFn();

  try {
    await redis.set(key, JSON.stringify(data), ttlSeconds);
  } catch {
    // Redis unavailable, memory cache below is the fallback.
  }

  memoryCache.set(key, { data, expiresAt: Date.now() + ttlSeconds * 1000 });

  return data;
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
 * Bulk invalidator. Drops every in-memory key starting with `prefix`.
 * Redis pattern delete would require SCAN; instead we let Redis entries
 * naturally expire on their TTL — acceptable for product list caches
 * keyed by varying query suffixes (page/limit/sort), which the user
 * already accepts a small staleness window on.
 */
export function invalidateCachedPrefix(prefix: string): void {
  for (const key of memoryCache.keys()) {
    if (key.startsWith(prefix)) memoryCache.delete(key);
  }
}
