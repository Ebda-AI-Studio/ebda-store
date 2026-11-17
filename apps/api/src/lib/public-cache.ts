import { createHash } from 'node:crypto';
import { redis } from '../services/redis.service';
import { BoundedMap } from './bounded-map';
import { revalidateStorefront } from './revalidate-storefront';
import { retryTransientRead } from './db-retry';
import { isWorkers } from './runtime';
import { dropEdgeGensMemo } from './edge-gens-memo';
import { cfWaitUntil } from '../cf/bindings';
import { currentIoTally } from './io-tally';
import logger from './logger';

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
 * Read path (`getCached`) tries Redis first, reads memory ONLY while
 * Redis is down, and on miss invokes the fetcher and writes to Redis (or,
 * when Redis is down, to memory), guarded by generation counters. Write
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
/**
 * DEV_STATS only (Ruling API-HANG-4): the AuthState deadlines a fill's leader hit, so a single-flight follower, which waited on
 * the same fill, carries them on its own request (`x-dev-io-ops`). Empty and unused in production (the tally has no `ops`).
 */
const fillTimeouts = new WeakMap<Promise<unknown>, string[]>();

/**
 * GENERATION COUNTERS (FIX-001). STALENESS CLASS: price/stock are NEVER-stale.
 *
 * A fill that read the DB BEFORE a write committed used to `redis.set` its
 * pre-write value AFTER that write's invalidation had already run, so the old
 * price/stock was republished for the whole TTL. Every invalidator now bumps a
 * generation (in Redis, shared by every replica, and locally) BEFORE deleting;
 * a fill captures the generations covering its key before `fetchFn`, skips its
 * write if any moved, and re-checks after writing (deleting its own entry if a
 * bump landed between check and write). A prefix bump is cut back to a `:`
 * boundary at most {@link GEN_MAX_DEPTH} segments deep, so a fill only has to
 * read `''`, its first {@link GEN_MAX_DEPTH} `seg:` prefixes and its own key.
 */
const GEN_MAX_DEPTH = 3;
/** Refreshed on every bump; outlives any fill by orders of magnitude. */
const GEN_TTL_SECONDS = 30 * 24 * 60 * 60;

/** The generations a fill of `key` must watch: root, `seg:` prefixes (≤ depth), the key. */
export function generationNamesFor(key: string): string[] {
  const names = [''];
  let idx = -1;
  for (let depth = 0; depth < GEN_MAX_DEPTH; depth++) {
    idx = key.indexOf(':', idx + 1);
    if (idx === -1) break;
    names.push(key.slice(0, idx + 1));
  }
  names.push(key);
  return names;
}

/** The generation a prefix bust bumps: the prefix cut back to a covering `:` boundary. */
export function generationNameForPrefix(prefix: string): string {
  let cut = 0;
  let idx = -1;
  for (let depth = 0; depth < GEN_MAX_DEPTH; depth++) {
    idx = prefix.indexOf(':', idx + 1);
    if (idx === -1) break;
    cut = idx + 1;
  }
  return prefix.slice(0, cut);
}

/**
 * Local generations guard the in-memory fallback (written only while Redis is
 * down). Values come from one monotonic sequence, so an evicted-then-rebumped
 * name can never repeat a value a fill captured earlier.
 */
let localGenSeq = 0;
const localGens = new BoundedMap<string, number>(10_000);

function readLocalGens(names: string[]): string {
  return names.map(n => localGens.get(n) ?? 0).join(',');
}

/** Shared generations as one comparable string, or null when Redis can't vouch for them. */
async function readSharedGens(names: string[]): Promise<string | null> {
  try {
    return (await redis.getCacheGenerations(names)).map(v => v ?? '0').join(',');
  } catch {
    return null;
  }
}

async function bumpGeneration(name: string): Promise<void> {
  localGens.set(name, ++localGenSeq);
  // Ruling NZ-D3: drop the edge-hit memo BEFORE the bump (a read that starts now cannot be remembered past it) and AFTER it
  // resolved (a read that started between the two drops, and memoised the pre-bump value, is forgotten). The isolate that
  // took the write never serves its own stale edge copy.
  dropEdgeGensMemo();
  try {
    await redis.bumpCacheGeneration(name, GEN_TTL_SECONDS);
  } catch {
    // Redis unavailable: no replica can write the shared layer either, and the
    // delete below fails the same way — the pre-existing outage residual.
  } finally {
    dropEdgeGensMemo();
  }
}

export async function getCached<T>(
  key: string,
  ttlSeconds: number,
  fetchFn: () => Promise<T>,
  /**
   * `cacheIf(data) === false` = return this value but store it in NO layer (a degraded answer,
   * e.g. a keyword-only fallback of a hybrid search, must never stand in for the full one).
   */
  opts: { cacheIf?: (data: T) => boolean } = {}
): Promise<T> {
  // FIX-002: the in-memory layer is a fallback for a DOWN Redis only. While
  // Redis is healthy another replica's invalidation clears Redis but can never
  // reach this process's memory, so reading memory on a healthy miss served the
  // pre-write price/stock for the whole TTL.
  let redisHealthy = redis.isAvailable();
  try {
    const cached = await redis.get<string>(key);
    if (cached) {
      return typeof cached === 'string' ? JSON.parse(cached) : (cached as T);
    }
  } catch {
    // Redis unavailable, fall through.
    redisHealthy = false;
  }

  // Workers: no in-process L1 at all. An isolate cannot see another isolate's
  // invalidation, so a write would stay invisible here for the whole TTL; KV is
  // the one shared cache.
  if (!redisHealthy && !isWorkers) {
    const memEntry = memoryCache.get(key);
    if (memEntry && memEntry.expiresAt > Date.now()) {
      return memEntry.data as T;
    }
  }

  // Miss on both layers: single-flight the fetch so concurrent callers for this
  // key don't each run fetchFn(). A late waiter that arrives after the fetch
  // resolved will re-read the now-warm cache on its next call.
  const existing = inFlight.get(key) as Promise<T> | undefined;
  if (existing) {
    const followerOps = currentIoTally()?.ops;
    if (!followerOps) return existing;
    try {
      return await existing;
    } finally {
      followerOps.push(...(fillTimeouts.get(existing) ?? []));
    }
  }

  const leaderOps = currentIoTally()?.ops;
  const leaderMark = leaderOps?.length ?? 0;
  const leaderTimeouts: string[] = [];
  const pending = (async () => {
    try {
      const genNames = generationNamesFor(key);
      const localBefore = readLocalGens(genNames);
      const sharedBefore = await readSharedGens(genNames);
      // A cache fill is a read by construction, so a dropped pooler connection
      // (Neon idling a socket — EBDA-API-2D/2E/2F) is re-run a bounded number of
      // times instead of 500ing the storefront. `fetchFn` MUST stay a pure read.
      const data = await retryTransientRead(fetchFn, {
        label: `getCached:${key.split(':')[1] ?? key}`,
      });

      const cacheable = opts.cacheIf ? opts.cacheIf(data) : true;
      if (cacheable && sharedBefore !== null) {
        const writeBack = async () => {
          if ((await readSharedGens(genNames)) !== sharedBefore) return;
          try {
            await redis.set(key, JSON.stringify(data), ttlSeconds);
            // An invalidation that bumped between the check above and this write
            // has already run (or is running) its delete; take our entry back out.
            if ((await readSharedGens(genNames)) !== sharedBefore) {
              await redis.delete(key);
            }
          } catch {
            // Redis failed mid-fill: nothing is cached this time (memory is only
            // written when Redis was already down at the start of the fill).
          }
        };
        // API-HANG-1: on Workers the write-back (generation check -> KV put -> re-check, two AuthState round trips + a KV
        // write) runs after the response, in waitUntil, instead of in front of it: same order, same checks, so the
        // NEVER-stale guarantee is unchanged, and waitUntil outlives a disconnecting client where the request path did not.
        // Node keeps awaiting it (its tests read the cache right after the fill).
        if (isWorkers) cfWaitUntil(writeBack());
        else await writeBack();
      }
      // Memory only when the shared layer is down (FIX-002), and never with a
      // value a local invalidation has superseded since the fetch began.
      if (
        cacheable &&
        !isWorkers &&
        sharedBefore === null &&
        readLocalGens(genNames) === localBefore
      ) {
        memoryCache.set(key, { data, expiresAt: Date.now() + ttlSeconds * 1000 });
      }
      return data;
    } finally {
      if (leaderOps)
        leaderTimeouts.push(
          ...leaderOps.slice(leaderMark).filter(o => o.startsWith('auth-state-timeout:'))
        );
    }
  })();

  if (leaderOps) fillTimeouts.set(pending, leaderTimeouts);
  inFlight.set(key, pending);
  try {
    return await pending;
  } finally {
    // An invalidation may have dropped this entry and a newer fill taken its slot.
    if (inFlight.get(key) === pending) inFlight.delete(key);
  }
}

/**
 * STALE-WHILE-REVALIDATE read (Ruling RESOLVE-SWR-1). Same two layers, same generation guard as `getCached`; the difference
 * is only WHEN an entry is considered usable:
 *
 *   age <= softSeconds                 served as is (what `getCached` does until its TTL)
 *   softSeconds < age <= hardSeconds   served STALE at once, and ONE background refresh runs (single-flight per key,
 *                                      waitUntil on Workers); the next read gets the fresh value
 *   age > hardSeconds                  the entry is gone (the layer's TTL is the hard max): a synchronous fill, as before
 *
 * Why: a cache miss on the public store payload cost 3-8 s (Logpush, 2026-11-15) and every shopper after an idle gap paid
 * it. With a stale window the shopper almost never pays the fill.
 *
 * STALENESS CLASS, declared here as the rules require: only what changed WITHOUT an event can be served stale, and only
 * for at most `hardSeconds` (BOUNDED-stale). Anything that is NEVER-stale (store status / suspension, plan and the feature
 * list it implies, slug, domain, deletion) is cleared by EVENT, not by this window: every writer calls `bustStoreCaches`
 * (services/store.service.ts), which goes through `invalidateCached`: bump the key's generation FIRST, then delete the entry
 * from KV and memory. A deleted entry cannot be served stale, and a refresh that began before the write cannot republish its
 * pre-write value (it captured the generation first and skips its write when the generation moved, exactly as a fill does).
 * `tests/unit/store-directory-bust-coverage.test.ts` fails when a writer of those columns has no bust.
 *
 * RESIDUAL (Ruling RESOLVE-SWR-1b, accepted): a KV delete takes up to ~60 s to reach other data centres, so a just-busted
 * entry can still be READ elsewhere for that long, with or without a stale window. Reads only; writes never use this cache.
 * Cost if wrong: a suspended store's pages stay browsable for ~60 s; no sale can complete.
 *
 * Entries written before this shape existed (a bare value, no envelope) are read as an ordinary TTL entry.
 * A failed background refresh keeps serving the stale copy until the hard max, then the synchronous fill surfaces the error.
 */
const SWR_MARK = '__swr1';
interface SwrEnvelope<T> {
  __swr1: 1;
  at: number;
  data: T;
}
function isSwrEnvelope(v: unknown): v is SwrEnvelope<unknown> {
  return (
    !!v &&
    typeof v === 'object' &&
    (v as Record<string, unknown>)[SWR_MARK] === 1 &&
    typeof (v as Record<string, unknown>).at === 'number'
  );
}
const swrRefreshing = new Set<string>();
const swrPending = new Set<Promise<void>>();

/** Resolves when every background refresh started so far has finished (tests; never awaited on the request path). */
export async function swrSettled(): Promise<void> {
  while (swrPending.size) await Promise.allSettled([...swrPending]);
}

export async function getCachedSwr<T>(
  key: string,
  softSeconds: number,
  hardSeconds: number,
  fetchFn: () => Promise<T>,
  opts: { cacheIf?: (data: T) => boolean } = {}
): Promise<T> {
  const got = await getCached<SwrEnvelope<T> | T>(
    key,
    hardSeconds,
    async () => ({ __swr1: 1 as const, at: Date.now(), data: await fetchFn() }),
    {
      cacheIf: v => (isSwrEnvelope(v) ? (opts.cacheIf ? opts.cacheIf(v.data as T) : true) : true),
    }
  );
  if (!isSwrEnvelope(got)) return got as T;
  if (Date.now() - got.at > softSeconds * 1000)
    refreshInBackground(key, hardSeconds, fetchFn, opts);
  return got.data as T;
}

function refreshInBackground<T>(
  key: string,
  hardSeconds: number,
  fetchFn: () => Promise<T>,
  opts: { cacheIf?: (data: T) => boolean }
): void {
  if (swrRefreshing.has(key)) return;
  swrRefreshing.add(key);
  const run: Promise<void> = (async () => {
    const genNames = generationNamesFor(key);
    const localBefore = readLocalGens(genNames);
    const sharedBefore = await readSharedGens(genNames);
    const data = await retryTransientRead(fetchFn, { label: `swr:${key.split(':')[1] ?? key}` });
    if (opts.cacheIf && !opts.cacheIf(data)) return;
    const env: SwrEnvelope<T> = { __swr1: 1, at: Date.now(), data };
    if (sharedBefore !== null) {
      // A write that landed while this refresh was reading has bumped the generation: our value predates it, drop it.
      if ((await readSharedGens(genNames)) !== sharedBefore) return;
      await redis.set(key, JSON.stringify(env), hardSeconds);
      if ((await readSharedGens(genNames)) !== sharedBefore) await redis.delete(key);
    } else if (!isWorkers && readLocalGens(genNames) === localBefore) {
      memoryCache.set(key, { data: env, expiresAt: Date.now() + hardSeconds * 1000 });
    }
  })()
    .catch(err => {
      logger.warn({ err, key }, '[public-cache] background refresh failed; serving the stale copy');
    })
    .finally(() => {
      swrRefreshing.delete(key);
      swrPending.delete(run);
    });
  swrPending.add(run);
  if (isWorkers) cfWaitUntil(run);
}

/**
 * Invalidate a cached entry from BOTH Redis and the in-memory fallback.
 * Without this, a write on the admin side leaves the storefront
 * serving stale rows until the TTL expires (60s for store, 120s for
 * categories, 30s for product lists). Call from every write path that
 * mutates the underlying data. Bumps the key's generation FIRST, so a fill
 * already in flight cannot republish its pre-write value afterwards.
 */
export async function invalidateCached(key: string): Promise<void> {
  await bumpGeneration(key);
  // A caller arriving after the write must not join a pre-write fetch.
  inFlight.delete(key);
  swrRefreshing.delete(key);
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
 * swallowed and the in-memory sweep still runs. Bumps the covering generation
 * FIRST (FIX-001), so a fill already in flight cannot republish afterwards.
 */
export async function invalidateCachedPrefix(prefix: string): Promise<void> {
  await bumpGeneration(generationNameForPrefix(prefix));
  for (const key of inFlight.keys()) {
    if (key.startsWith(prefix)) inFlight.delete(key);
  }
  for (const key of swrRefreshing) {
    if (key.startsWith(prefix)) swrRefreshing.delete(key);
  }
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
/**
 * Redis-only half, so a caller that will purge for itself doesn't
 * double-fire. Genuinely Redis-only — do NOT add a revalidateStorefront call
 * here. It used to call revalidateStorefront itself, contradicting this very
 * comment: invalidateStoreCategoriesCaches called it AND then called
 * revalidateStorefront again below, firing the storefront's revalidate POST
 * twice per categories write, and invalidateStoreProductCaches called it
 * assuming (per this doc comment) that it was Redis-only, so every product
 * write ALSO fired an extra unwanted POST for the categories tag.
 */
async function clearCategoriesRedis(storeId: string): Promise<void> {
  // Redis ONLY — the storefront purge is the caller's (#1220). This helper
  // used to fire its own purge as well, so every product write and every ORDER
  // sent two outbound purges, and a category write sent the same tag twice.
  await allInvalidations([
    invalidateCached(`public:categories:${storeId}`),
    invalidateCached(`admin:categories:${storeId}`),
  ]);
}

/**
 * Run independent invalidations TOGETHER (Ruling PERF-LAT-2). Each one keeps its own order inside (generation bump FIRST,
 * then the delete), and the keys and prefixes are disjoint, so nothing depends on another finishing. Run one after another
 * they cost a serial round trip each (the order path made ~18 of its 38 that way, PERF-LAT-1). Every invalidation runs to
 * its end even when another fails (a serial chain stopped at the first throw and left the rest stale), and the first
 * failure is re-thrown afterwards, so the caller logs or alerts exactly as before.
 */
export async function allInvalidations(tasks: Array<Promise<void>>): Promise<void> {
  const settled = await Promise.allSettled(tasks);
  const failed = settled.find((r): r is PromiseRejectedResult => r.status === 'rejected');
  if (failed) throw failed.reason;
}

export async function invalidateStoreCategoriesCaches(storeId: string): Promise<void> {
  await clearCategoriesRedis(storeId);
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
 *
 * Also busts the bundle-list cache: `bundle.routes.ts`'s public list resolves
 * each bundle's `price`/`componentSum`/`available` from its component
 * PRODUCTS' current price/inventory (NEVER-stale data), so a product write
 * that changes either — including checkout-driven inventory decrement —
 * would otherwise leave a bundled product's stock/price wrong in the cached
 * bundle list for up to its own TTL. It is also the ONLY bundle invalidator: the 3
 * bundle write handlers call this function (there is no bundles-only one).
 */
/**
 * The Redis half of {@link invalidateStoreProductCaches}, shared with the
 * order path ({@link invalidateStoreProductCachesAfterOrder}) — both funnel
 * through here so the bundle-list bust below can't be forgotten by either.
 */
export async function clearProductsRedis(storeId: string): Promise<void> {
  // All together (allInvalidations): disjoint keys, each bump-then-delete on its own. Every one still runs and is awaited.
  await allInvalidations([
    invalidateCachedPrefix(`public:products:${storeId}:`),
    invalidateCachedPrefix(`public:product:${storeId}:`),
    invalidateCachedPrefix(`public:suggest:${storeId}:`),
    // B2B C1: recommendation payloads embed related products (name, image, price), so a product audience flip must drop them too.
    invalidateCachedPrefix(`recommendations:product:${storeId}:`),
    invalidateCachedPrefix(`admin:products:${storeId}:`),
    // Redis-only: the caller fires ONE purge covering both tags. Calling the
    // public categories invalidator here would fire a second outbound POST for
    // every product write — two requests per bust, and two per order.
    clearCategoriesRedis(storeId),
    invalidateCached(bundlesCacheKey(storeId)),
  ]);
}

export async function invalidateStoreProductCaches(storeId: string): Promise<void> {
  await clearProductsRedis(storeId);

  // Clearing Redis is only half the job. The Next.js storefront caches the
  // API's RESPONSE in its own data cache, so after a save the merchant kept
  // seeing the old product until that window expired — which is why saving
  // twice "worked": the second save just took long enough. Every storefront
  // product fetch is tagged `products:<storeId>`; purge it here, at the one
  // place every writer already funnels through, so no call site can forget.
  // Fire-and-forget by design (see revalidate-storefront) — a storefront blip
  // must never fail a save that already committed.
  // ONE request carrying every tag. revalidateStorefront accepts a list, so
  // there is no reason to open a second connection to say another part.
  revalidateStorefront({
    tags: [`products:${storeId}`, `categories:${storeId}`, `bundles:${storeId}`],
  });
}

/**
 * A blog post write (create / update / delete): the storefront renders /blog and /blog/<slug> server-side, so the
 * edge HTML copy and the Next data cache (fetches tagged `blog:<storeId>`) must drop. Without this the HTML edge copy of a
 * blog page could outlive the edit for its whole stale window (STORE-EDGE-4). Fire-and-forget like every purge.
 */
export function purgeStorefrontBlog(storeId: string): void {
  revalidateStorefront({ tags: [`blog:${storeId}`] });
}

/**
 * Cache key for a store's public purchasable-bundle list (`bundle.routes.ts`).
 * v2 (PR 2301): the cached value now holds each bundle's sale window instead
 * of a pre-applied `isPurchasable` (issue 2111). A v1 entry read by the v2
 * reader would filter every bundle out, so the bump makes it a clean miss.
 */
export function bundlesCacheKey(storeId: string): string {
  return `public:bundles:v2:${storeId}`;
}

// There is deliberately NO bundles-only invalidator (removed in S2-REVIVE, Ruling STORE-EDGE-2: it had zero call sites).
// Every bundle write (bundle.routes.ts create/update/deactivate) calls `invalidateStoreProductCaches`, which clears
// `bundlesCacheKey` in `clearProductsRedis` and purges `bundles:<storeId>` in its one storefront request, and a bundle's
// price/availability also depends on its component products, which only that function covers. Pinned by
// tests/unit/storefront-purge-on-write.test.ts (bundle writes) and tests/unit/public-cache-invalidation.test.ts.

/**
 * How long an order-driven storefront purge is coalesced per store (#1220).
 *
 * STALENESS CLASS: inventory is NEVER-stale, and this keeps every write path
 * invalidating: the API's Redis layer is cleared on EVERY order, immediately,
 * and the storefront purge is leading-edge — the first order in a quiet period
 * purges at once. Only a BURST is coalesced: orders arriving while a purge
 * window is open share ONE trailing purge at its end. The residual is that,
 * mid-burst, the storefront's own data cache may show stock up to this long
 * behind. That residual is display only — checkout re-reads stock from the
 * database on every order, so it cannot oversell.
 */
export const ORDER_PURGE_COALESCE_MS = 10_000;

/** Open coalescing windows by store: `pending` = an order arrived mid-window; `openedAt` = when it opened. */
const orderPurgeWindows = new BoundedMap<string, { pending: boolean; openedAt: number }>(10_000);

function purgeStorefrontProducts(storeId: string): void {
  revalidateStorefront({
    tags: [`products:${storeId}`, `categories:${storeId}`, `bundles:${storeId}`],
  });
}

/**
 * Open a window and schedule its trailing purge. The wait is a promise handed to `ctx.waitUntil`
 * (`cfWaitUntil`), NOT a bare `setTimeout`: Workers do not promise a timer survives the response, so a
 * dropped timer left the window open for the isolate's life and the NEVER-stale inventory purge never
 * fired. As a second line, `invalidateStoreProductCachesAfterOrder` treats a window older than
 * 2x the coalesce time as dead and purges itself, so even a dropped waitUntil costs at most one extra window.
 */
function openOrderPurgeWindow(storeId: string): void {
  const window = { pending: false, openedAt: Date.now() };
  orderPurgeWindows.set(storeId, window);
  cfWaitUntil(
    new Promise<void>(resolve => {
      const timer = setTimeout(resolve, ORDER_PURGE_COALESCE_MS);
      // Never hold the process open for a cache purge.
      timer.unref?.();
    }).then(() => {
      if (orderPurgeWindows.get(storeId) !== window) return;
      if (window.pending) {
        purgeStorefrontProducts(storeId);
        openOrderPurgeWindow(storeId);
      } else {
        orderPurgeWindows.delete(storeId);
      }
    })
  );
}

/**
 * The order path's product-cache bust: stock changed, content did not.
 *
 * `OrderService` used to call {@link invalidateStoreProductCaches} on every
 * checkout and every inventory-affecting status change, so each order purged
 * every `products:<storeId>`, `categories:<storeId>` AND `bundles:<storeId>`
 * storefront fetch — the homepage blocks, the PLP, every PDP, the sitemap and
 * the feed. During a flash sale the storefront's data cache was invalidated
 * faster than it could be used and every render fell through to the API.
 * Bundles stay in this purge (not split out) because their price/availability
 * derive from the same component-product inventory an order just changed —
 * see the bundle paragraph on {@link invalidateStoreProductCaches}. Content
 * edits keep the immediate purge; see {@link ORDER_PURGE_COALESCE_MS} for
 * this one.
 */
export async function invalidateStoreProductCachesAfterOrder(storeId: string): Promise<void> {
  await clearProductsRedis(storeId);
  const open = orderPurgeWindows.get(storeId);
  if (open && Date.now() - open.openedAt < ORDER_PURGE_COALESCE_MS * 2) {
    open.pending = true;
    return;
  }
  // No window, or one whose trailing purge never ran (dropped timer/waitUntil): purge now, start fresh.
  purgeStorefrontProducts(storeId);
  openOrderPurgeWindow(storeId);
}

/** Cache key for the admin aggregated-customers snapshot (`customers.routes.ts`). */
export function customersCacheKey(storeId: string): string {
  // v2 (2026-09-30): the cached value gained `summary` (KPI strip). A v1
  // entry has none, so reading one after deploy would show an empty strip
  // for up to the 300s TTL — the version bump makes it a clean miss instead.
  // v3 (PR 2301): gained `ordersTruncated`/`zeroOrderTruncated`; a v2 entry
  // would drop the export's truncation notice rows.
  // v4 (issue 2235): spend/repeat-rate now exclude failed-payment orders; a
  // v3 entry would show the old population for up to its TTL.
  return `customers-agg:v4:${storeId}`;
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

/**
 * Workers KV refuses keys over 512 bytes, and the full KV key is `[namespace]cache:<key>`. A longer
 * key made the get/put throw and the request silently went uncached (Task 12 review M7). Keys
 * longer than this are hashed: `<prefix>sha256:<hex of the suffix>`. The prefix stays readable, so
 * prefix invalidation (`invalidateCachedPrefix('public:products:<storeId>:')`) still covers them;
 * sha-256 of the canonical suffix keeps distinct inputs distinct.
 */
export const CACHE_KEY_MAX_BYTES = 400;

export function boundedCacheKey(prefix: string, suffix: string): string {
  const full = prefix + suffix;
  if (new TextEncoder().encode(full).length <= CACHE_KEY_MAX_BYTES) return full;
  return `${prefix}sha256:${createHash('sha256').update(suffix).digest('hex')}`;
}
