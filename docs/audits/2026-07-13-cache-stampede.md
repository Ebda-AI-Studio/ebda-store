# Ebda Store — Cache Stampede Audit

Read-only audit of `ebda-store` (root checkout, `main`, clean).
Lens: for every caching layer — on concurrent misses of the same key, how many rebuilds run?
Single-flight? Fixed vs jittered TTL? What invalidation-storm paths exist?

Scale assumption used throughout: **single Egypt merchant (demo-merchant) in production**, single
Railway API instance (no `railway.json` replica config, docs confirm "single-merchant scale"),
realistic peak load ~100 req/min with occasional promo-driven bursts. A stampede needs real
concurrency; severities below are calibrated to that, not to Black-Friday-at-Shopify scale.

## Tally

- **Critical: 0**
- **High: 1** (H1 — inner product-list cache defeats invalidation)
- **Medium: 2** (M1 — feature-flag cache has no single-flight; M2 — bulk import never busts the public cache)
- **Low: 2** (L1 — `/public/store` legacy endpoint uncoalesced; L2 — CF Workers store-resolver has no cross-isolate coalescing)
- **Safe / already mitigated: 4** (public-cache.ts single-flight; edge s-maxage/SWR; Redis SCAN+UNLINK invalidation; single-instance topology bounding blast radius)

---

## Findings

### H1 — `ProductService.listPublic`'s inner Redis cache is never invalidated, silently re-poisoning the outer (correctly-invalidated) cache

**File:** `apps/api/src/services/product.service.ts:1074-1099` (cache key `products:store:${storeId}:${cacheParams}`, TTL 120s, lines 205/283/629 write `redis.set(cacheKey, ..., 120)`)
**Also:** `apps/api/src/routes/public.routes.ts:196-216` (outer cache key `public:products:${storeId}:...`, TTL 120s, wrapped in `getCached` — single-flight safe)

This isn't strictly a concurrency/stampede bug — it's an invalidation-correctness bug discovered while tracing the stampede path, and it directly undermines the mitigation the team already built. `/public/products` wraps `ProductService.listPublic()` in the safe, single-flight `getCached()` under key `public:products:${storeId}:...`. But `listPublic()` **also** does its own raw `redis.get`/`redis.set` under a _different_ key (`products:store:${storeId}:...`, no `public:` prefix). `invalidateStoreProductCaches()` (`public-cache.ts:124-128`) only sweeps the `public:products:`, `public:product:`, and `public:suggest:` prefixes — it never touches `products:store:`.

Concrete sequence: merchant edits a price → `ProductService.update()` calls `invalidateStoreProductCache()` → outer `public:products:*` cache is correctly busted. Next storefront request misses the outer cache, calls the fetcher (`listPublic`), which itself reads the **stale, never-invalidated** `products:store:*` key (up to 120s old) and returns _that_ — then writes the stale payload right back into the freshly-busted outer cache, effectively cancelling the invalidation for another 120s. Net effect: a price/stock correction can appear to "not have invalidated" even though the write path did everything right.

Not a concurrency amplifier (only one process reaches this per pod per outer miss), but a real correctness defect adjacent to the stampede surface, and it's the kind of thing that gets misdiagnosed as a stampede-mitigation failure later. `getCategories()` (line 1602) has the identical inner-cache pattern but IS correctly invalidated (`categories:store:${storeId}` exact-key delete at `product.service.ts:515`), so this is a partial/inconsistent application of the double-cache pattern, not a deliberate design.

**Fix (cheap):** delete the inner `redis.get`/`redis.set` block in `listPublic()` (lines 1089-1099, 205, 283, 629) — it's fully redundant with the outer `getCached()` wrapper and only route callers ever invoke it. If a non-route caller needs the memoized behavior, invalidate `products:store:` under the same prefix sweep in `invalidateStoreProductCaches()` instead.

---

### M1 — `FeatureService` has no single-flight; every concurrent cold read of a store's feature map runs its own 2-query DB read

**File:** `apps/api/src/services/feature.service.ts:139-154` (`getStoreFeatures`), `18-33` (`readFromCache`), `88-114` (`readFromDb`)

300s Redis TTL, no in-memory fallback, no in-flight promise map (contrast with `public-cache.ts`'s `inFlight` Map, which this file doesn't reuse). On a cold key, `readFromDb()` runs `Promise.all([store.findUnique, storeFeature.findMany])` inside `withRlsBypass` — 2 DB round trips per concurrent miss.

Most call sites are naturally low-concurrency for a single small merchant: checkout-adjacent paths (`cart.service.ts` backorder check, `order.service.ts`, `tax.service.ts`, `loyalty.service.ts` — 8 call sites), Inngest background functions (one execution at a time per job), and `requireFeature()` middleware (gated admin routes, not public hot paths). The two genuinely public/hot call sites — `getEnabledFeatureKeys()` inside `/public/store/resolve` and `/public/stores/:slug` (`public.routes.ts:1183`, `1391`) — are _already_ protected because they execute inside those routes' outer `getCached()` fetcher, so `FeatureService`'s own gap doesn't matter there.

The real exposure is `cart.service.ts`'s `isFeatureEnabled(storeId, 'backorder')` check (3 call sites: add/update/remove cart item) — every add-to-cart request. At 100 req/min baseline this rarely collides on a cold-TTL-boundary millisecond; during a flash-sale/promo push where dozens of customers add-to-cart within the same second right as the 300s TTL rolls over, you'd get N concurrent `readFromDb()` calls instead of 1. Not a DB-melting event at this scale (2 lightweight queries × maybe 10-20 concurrent adds), but it's the one place in the codebase where the "reel scenario" (TTL expires, herd hits DB) could actually reproduce, because unlike the product/store caches it has zero single-flight protection anywhere in its call graph.

**Fix (cheap):** copy the `inFlight = new Map<string, Promise<T>>()` pattern from `public-cache.ts` into `FeatureService.readFromDb`/`getStoreFeatures` — same 10-line shape, keyed by `storeId`. Given `FeatureService` is a singleton class already, this is a same-file change with no API surface impact.

---

### M2 — Bulk product import never invalidates the public product cache (staleness bug, not a stampede — but worth fixing in the same pass)

**File:** `apps/api/src/services/bulk.service.ts` (1196 lines) — zero occurrences of `invalidate`, `Cache`, or `redis.` anywhere in the file. `apps/api/src/lib/inngest/functions/bulk-import.ts` (the Inngest wrapper) also never invalidates.

The task asked "what happens after a 500-product bulk import?" expecting an invalidation-storm risk (many `SCAN+UNLINK` calls back-to-back). The actual finding is the opposite failure mode: `BulkService.importProducts()` writes products via raw batched Prisma calls (`prisma.product.*`, see the `BATCH_SIZE` loop at `bulk.service.ts:795`) and **never calls `invalidateStoreProductCaches()`**. So there's no invalidation storm — but a 500-product CSV import leaves the storefront serving the pre-import product list/detail/suggest cache for up to a full 120s TTL window regardless of import size, which for a merchant who just imported their whole catalog is a worse UX than a brief stampede would be.

Since this isn't the requested lens (stampede), I'm not scoring it against the stampede severity scale, but flagging it because it's the actual behavior at that exact code path the prompt asked about, and it's a one-line fix.

**Fix:** call `invalidateStoreProductCaches(job.storeId)` once after `BulkService.importProducts()` completes in `bulk-import.ts:60-79` (not per-row — a single sweep after the batch loop finishes is correct and cheap).

---

### L1 — `/public/store` (legacy "default store" endpoint) has no single-flight, no invalidation hook

**File:** `apps/api/src/routes/public.routes.ts:1213-1274`, raw `redis.get`/`redis.set` under key `store:default`, TTL 300s.

Same shape as the other un-wrapped raw caches but low severity: only one caller (`apps/web/src/lib/api.ts:792`), no `invalidateCached('store:default')` call anywhere in the codebase (comment at line 1254 acknowledges this: "default store rarely changes... keeps merchant edits visible without an explicit invalidate hook" — accepted staleness, not a bug). No single-flight, but a single-tenant global endpoint with no per-store fan-out; even a full herd here is a handful of concurrent `prisma.store.findFirst()` calls, trivial DB cost.

**Fix:** low priority. If touched, reuse `getCached()` for consistency rather than hand-rolling.

---

### L2 — `apps/web/src/lib/store-resolver.ts`: per-isolate 8s cache has no cross-isolate coalescing, but the layer underneath it is centralized, not per-isolate

**File:** `apps/web/src/lib/store-resolver.ts:175-182` (`storeCache` Map, 8s TTL), `211-227`/`357-373` (`fetchStoreByDomain`/`fetchStoreBySlug`, Next `fetch()` with `revalidate: 15` + tags)

Two layers here, and they behave very differently on CF Workers:

1. **The 8s in-memory `Map`** — genuinely per-isolate, no lock/promise-sharing, so two concurrent requests hitting a cold isolate for the same domain each call `fetchStoreByDomain()` independently. This is the theoretical "N isolates → N concurrent origin fetches" scenario from the prompt. In practice the race window is tiny (8s TTL, and only the very first request per isolate per 8s window can double-fire) and CF only spins up additional isolates in response to real concurrent request volume at an edge location — for a single small Egypt merchant, realistic simultaneous isolate count for the same domain is low (most traffic is Egypt-region, likely 1-2 warm isolates at any moment, not global fan-out).
2. **Next's fetch data cache underneath it (`revalidate: 15`, tags)** is backed by `apps/web/open-next.config.ts`'s `r2IncrementalCache` — an **R2 bucket** (`force-web-isr-cache`), confirmed in `apps/web/wrangler.jsonc`. This is centralized, not per-isolate memory, which is the real mitigating fact: after a `revalidateTag` purge, the fallback layer isolates fall through to is one shared R2-backed cache, not N independent origin calls to the API. R2 reads have their own latency but it's one shared cache, and OpenNext's R2 incremental cache does not implement its own distributed lock — so a genuine burst of concurrent requests across multiple isolates immediately after a tag purge _could_ each miss R2 and call the API's `/public/store/resolve` concurrently. But that endpoint is itself `getCached()`-wrapped with single-flight on the API side (single Railway instance), so the worst case is bounded to "however many isolates raced the R2 miss window" hitting one already-protected API endpoint — not an amplifying multi-layer stampede.

**Verdict: safe enough at current scale, not free of theoretical gaps.** The 8s memory layer is the only place with zero coalescing of any kind, and it's the smallest-blast-radius layer (single isolate, 8s window). Not worth adding single-flight machinery here — the cost/benefit doesn't clear the bar Ahmad's "don't inflate severity" instruction sets, given the API layer beneath it already single-flights.

**Fix:** none recommended at current scale. If Ebda AI Studio's traffic ever crosses into multi-tenant/high-concurrency territory, revisit by adding a promise-map guard to `resolveStoreByDomain`/`resolveStoreBySlug` (same 10-line pattern as `public-cache.ts`).

---

## Safe / already mitigated (credit given, no further action)

- **`apps/api/src/lib/public-cache.ts` — `getCached()`.** This is the one layer in the whole codebase that explicitly and correctly solves the stampede problem: Redis L1 → in-memory `BoundedMap` L2 → **in-process `inFlight: Map<string, Promise<unknown>>` single-flight** on a double-miss (`public-cache.ts:33-77`). Concurrent misses on the same key share one `fetchFn()` call; only cross-pod concurrency (bounded by Railway instance count, currently 1) can duplicate work. Well-commented, well-designed — used by `/public/products`, `/public/products/:slugOrId`, `/public/categories`, `/public/suggest`, `/public/stores/:slugOrId`, `/public/store/resolve`. This is the reel's answer already implemented correctly for the highest-traffic endpoints.
- **`invalidateStoreProductCaches` / `invalidateCachedPrefix` / `redis.deleteByPattern`** (`public-cache.ts:104-128`, `redis.service.ts:184-199`) — non-blocking `SCAN` (COUNT 200) + `UNLINK` rather than blocking `KEYS`+`DEL`. Correctly implemented; won't stall the event loop or other Redis clients even under a large prefix sweep. No invalidation-storm risk from this mechanism itself.
- **`setEdgeCache`** (`apps/api/src/lib/edge-cache.ts`) — `s-maxage` + `stale-while-revalidate` on every public GET (60-120s fresh / 300-600s SWR). Its doc comment is stale (says "Vercel's edge" — Vercel was cancelled 2026-07-07 per `docs/ENVIRONMENT.md`); the API's real edge is whatever sits in front of `api.ebda.app` on Railway. **Worth a docs fix**, but functionally this SWR contract is real mitigation regardless of which CDN honors it — even without an edge cache in front, `stale-while-revalidate` semantics only matter if something respects `Cache-Control`, so flag for verification: confirm `api.ebda.app` DNS is Cloudflare-proxied (orange-cloud) so these headers actually get honored at the edge, otherwise this layer is currently a no-op comment-only mitigation. **CLOSED 2026-09-02 (audit-followup #1145):** verified from a live response — `api.ebda.app` IS Cloudflare-proxied (`server: cloudflare`, `cf-ray` present), but `cf-cache-status: DYNAMIC`: CF forwards these JSON responses without caching them absent an explicit cache rule. So the layer is honored-but-inert today, and becomes load-bearing the moment a cache rule is added — which is why `setEdgeCache` now defaults `Vary` to BOTH tenant selectors (`x-store-id`, `x-store-domain`) and merges via `res.vary()` so the cors middleware's `Vary: Origin` survives.
- **Single Railway instance topology.** `railway.json` sets no replica count; `docs/DEPLOYMENT.md` confirms "single-merchant scale (demo-merchant only)". This caps every stampede scenario's real blast radius at "one process, one event loop" — the `inFlight` single-flight map fully covers same-key concurrent misses with zero cross-pod duplication today. Re-audit this section if/when Railway horizontal scaling is turned on (multi-pod would reintroduce the "at most N pods redo the work" case the `public-cache.ts` comment already anticipates).
- **DB pool sizing** (`packages/database/src/index.ts:26-53`) — `connection_limit=15` per instance (bumped from 5 after a documented P2028/pool-starvation incident, see the code comment referencing "~220x/day timed out fetching a new connection"). At single-instance scale with the existing single-flight coverage on the hottest paths, worst-case concurrent rebuild fan-out (product list + category + store-resolve all cold at once) is on the order of 3-5 queries, nowhere near 15. Feature-service's uncoalesced path (M1) is the only place that could meaningfully add to this under a real burst, and even then it's 2 lightweight queries per concurrent add-to-cart.

---

## Summary for Ahmad

The team already built the correct primitive (`inFlight` single-flight map in `public-cache.ts`) and applied it to every high-traffic public read except the feature-flag cache. Nothing here is DB-melting at demo-merchant's actual scale — single Railway instance + single-flight on the hot paths already bounds the blast radius to "at most 1 redundant query" for products/categories/store-resolve. The two things worth actually fixing:

1. **H1** — delete `ProductService.listPublic`'s redundant inner cache (`products:store:*`); it's silently defeating your own invalidation calls. This is a live correctness bug, not theoretical.
2. **M2** — one-line fix: call `invalidateStoreProductCaches` once after `BulkService.importProducts()` finishes so bulk-imported prices/stock show up immediately instead of after a 120s TTL wait.

M1 (feature-flag single-flight) is a 10-line copy-paste of the existing pattern — cheap enough to do opportunistically even though current traffic won't trigger it often. L1/L2 are documented as "not worth it at this scale" — don't spend time on them unless traffic profile changes.

---

## Addendum — fixes applied (2026-07-13, branch `fix/cache-stampede-audit`)

All findings above were triaged and fixed except the one explicit skip called out in L2's own "not worth fixing at current scale" verdict (skipped as-is, per the audit's own recommendation — no code change). See the PR body for the full findings→fix table, test evidence, and the answer to the `api.ebda.app` CF-proxy open item (answered from `docs/DEPLOYMENT.md`'s DNS table, not left open).
