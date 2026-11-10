/**
 * Ruling WEB-COLD-2: the storefront's DATA cache (Next `fetch(..., { next: { revalidate, tags } })` entries, the API JSON
 * every SSR render reads) survives a deploy. OpenNext's R2 incremental cache stores every entry under the build id
 * (`incremental-cache/<BUILD_ID>/<hash>.<type>`), so each deploy started with an EMPTY data cache and the first render of
 * every store paid the whole API chain live (store resolve -> layout -> product lists, each 0.5-3 s on an API cache miss):
 * measured 7.6 s for a cold local render with an empty cache, 12.1 s for jasmine/ar in the deploy warm step.
 *
 * Only `fetch` entries move to one build-independent key space (`incremental-cache/shared-fetch/<hash>.fetch`). Pages,
 * route handlers and composable entries keep the build-scoped key: their bodies name this build's `/_next/static` files.
 *
 * Why this is safe:
 *  - The key is Next's fetch-cache key: a hash of the URL, method, headers and body plus Next's own cache-key version,
 *    so a different API host (a preview Worker pointed at staging) or a Next upgrade never reads another one's entry.
 *  - Invalidation is unchanged: the sharded Durable Object tag cache is NOT build-scoped, so a `revalidateTag` (layout
 *    save, product edit, store purge) recorded under any build marks a carried-over entry stale, exactly as before.
 * CACHE CLASS: unchanged per call site (each `fetch` keeps its own `revalidate` + tags; the NEVER-stale reads stay
 * `cache: 'no-store'`, which never reaches this cache). New residual: right after a deploy, an entry written by the
 * previous build is served under the same stale-while-revalidate rules as any other entry, so a deploy that ships code
 * expecting a NEW API field sees the old JSON shape for at most that fetch's `revalidate` window plus one request.
 */
import { getCloudflareContext } from '@opennextjs/cloudflare';
import { computeCacheKey } from '@opennextjs/cloudflare/overrides/internal';
import r2IncrementalCache from '@opennextjs/cloudflare/overrides/incremental-cache/r2-incremental-cache';

/** The build segment every `fetch` entry is stored under, whatever build wrote or reads it. */
export const SHARED_FETCH_SEGMENT = 'shared-fetch';
const PREFIX_ENV_NAME = 'NEXT_INC_CACHE_R2_PREFIX';

type R2Cache = typeof r2IncrementalCache & {
  getR2Key(key: string, cacheType?: string): string;
};

/** The R2 object key for `key`: build-independent for `fetch` entries, the stock build-scoped key otherwise. */
export function sharedFetchR2Key(
  key: string,
  cacheType: string | undefined,
  prefix: string | undefined,
  stock: (key: string, cacheType?: string) => string
): string {
  if (cacheType !== 'fetch') return stock(key, cacheType);
  return computeCacheKey(key, { prefix, buildId: SHARED_FETCH_SEGMENT, cacheType });
}

/**
 * The stock R2 incremental cache with only its key function replaced. `get`/`set`/`delete` all call `this.getR2Key`, so
 * an object whose prototype is the stock instance reuses every line of its R2 handling.
 */
export function withSharedFetchKeys(base: R2Cache, prefixOf: () => string | undefined): R2Cache {
  const cache = Object.create(base) as R2Cache;
  cache.getR2Key = (key: string, cacheType?: string) =>
    sharedFetchR2Key(key, cacheType, prefixOf(), (k, t) => base.getR2Key(k, t));
  return cache;
}

// The prefix is read per call, exactly like the stock cache: the binding env exists only inside a request.
export default withSharedFetchKeys(
  r2IncrementalCache as R2Cache,
  () =>
    (getCloudflareContext().env as unknown as Record<string, string | undefined>)[PREFIX_ENV_NAME]
);
