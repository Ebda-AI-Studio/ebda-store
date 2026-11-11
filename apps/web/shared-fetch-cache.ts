/**
 * Ruling WEB-COLD-2: the storefront's DATA cache (Next `fetch(..., { next: { revalidate, tags } })` entries, the API JSON
 * every SSR render reads) survives a deploy. OpenNext's R2 incremental cache stores every entry under the build id
 * (`incremental-cache/<BUILD_ID>/<hash>.<type>`), so each deploy started with an EMPTY data cache and the first render of
 * every store paid the whole API chain live (store resolve -> layout -> product lists, each 0.5-3 s on an API cache miss):
 * measured 7.6 s for a cold local render with an empty cache, 12.1 s for jasmine/ar in the deploy warm step.
 *
 * Only `fetch` entries move to a key space keyed by the DATA CONTRACT instead of the build
 * (`incremental-cache/shared-fetch-<contract>/<hash>.fetch`). Pages, route handlers and composable entries keep the
 * build-scoped key: their bodies name this build's `/_next/static` files.
 *
 * CONTRACT: `<contract>` is a hash of the files that define the shape of the API data the storefront parses
 * (scripts/ci/fetch-contract-version.mjs: packages/shared types/schemas/builder + the storefront's ResolvedStore), baked
 * in at build time by scripts/cf-setup-local.sh. A deploy that changes any of them starts an empty namespace (new code
 * never reads old-shaped JSON); a deploy that changes none of them keeps the warm cache.
 *
 * Why this is safe:
 *  - The key is Next's fetch-cache key: a hash of the URL, method, headers and body plus Next's own cache-key version,
 *    so a different API host (a preview Worker pointed at staging) or a Next upgrade never reads another one's entry.
 *  - Invalidation is unchanged: the sharded Durable Object tag cache is NOT build-scoped, so a `revalidateTag` (layout
 *    save, product edit, store purge) recorded under any build marks a carried-over entry stale, exactly as before.
 * CACHE CLASS: BOUNDED-stale. Every entry here comes from a `fetch` with its own `revalidate` (15 s store resolve, 60 s
 * layout/catalogue lists, 300 s testimonials) and is purged early by `revalidateTag` from the API on merchant writes
 * (`store-domain:*`, `layout:*`, `products:*`). Residual window: the call site's `revalidate`, served stale once while
 * one request refreshes it. Prices and stock reach the storefront through `products:<storeId>`-tagged entries; every
 * product/variant/price/stock write path purges that tag, and the tag cache is NOT build-scoped, so the purge reaches an
 * entry carried over from an older build (tests/unit/web-shared-fetch-cache.test.ts proves it with the real adapter and
 * tag cache). Checkout, cart and quote reads are `cache: 'no-store'` and never reach this cache.
 */
import { getCloudflareContext } from '@opennextjs/cloudflare';
import { computeCacheKey } from '@opennextjs/cloudflare/overrides/internal';
import r2IncrementalCache from '@opennextjs/cloudflare/overrides/incremental-cache/r2-incremental-cache';

const PREFIX_ENV_NAME = 'NEXT_INC_CACHE_R2_PREFIX';
/** A contract version: the 16-hex hash from fetch-contract-version.mjs, or a lower-case label for local configs. */
const CONTRACT = /^[a-z0-9-]{1,64}$/;

type R2Cache = typeof r2IncrementalCache & {
  getR2Key(key: string, cacheType?: string): string;
};

/** The key segment fetch entries of data contract `contract` live under, whatever build wrote or reads them. */
export function sharedFetchSegment(contract: string): string {
  if (!CONTRACT.test(contract))
    throw new Error(`shared-fetch-cache: invalid contract version "${contract}"`);
  return `shared-fetch-${contract}`;
}

/** The R2 object key for `key`: contract-scoped for `fetch` entries, the stock build-scoped key otherwise. */
export function sharedFetchR2Key(
  key: string,
  cacheType: string | undefined,
  prefix: string | undefined,
  contract: string,
  stock: (key: string, cacheType?: string) => string
): string {
  if (cacheType !== 'fetch') return stock(key, cacheType);
  return computeCacheKey(key, { prefix, buildId: sharedFetchSegment(contract), cacheType });
}

/**
 * The stock R2 incremental cache with only its key function replaced. `get`/`set`/`delete` all call `this.getR2Key`, so
 * an object whose prototype is the stock instance reuses every line of its R2 handling.
 */
export function withSharedFetchKeys(
  base: R2Cache,
  contract: string,
  prefixOf: () => string | undefined
): R2Cache {
  sharedFetchSegment(contract); // fail at config load, not on the first request
  const cache = Object.create(base) as R2Cache;
  cache.getR2Key = (key: string, cacheType?: string) =>
    sharedFetchR2Key(key, cacheType, prefixOf(), contract, (k, t) => base.getR2Key(k, t));
  return cache;
}

/** The incremental cache for `open-next.config.ts`; `contract` is baked in by scripts/cf-setup-local.sh. */
export function createSharedFetchCache(contract: string): R2Cache {
  // The prefix is read per call, exactly like the stock cache: the binding env exists only inside a request.
  return withSharedFetchKeys(
    r2IncrementalCache as R2Cache,
    contract,
    () =>
      (getCloudflareContext().env as unknown as Record<string, string | undefined>)[PREFIX_ENV_NAME]
  );
}
