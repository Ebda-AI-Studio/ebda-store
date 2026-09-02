# Adversarial Audit — Availability & Cost (slug: availability-cost)

Repo: force-website-builder @ commit 4f202f22 (graph baseline; corrected 2026-09-02 —
the original citation, 34353bbf, does not exist in this repository, per #1158). Read-only.
Attacker model: hostile customer / hostile-or-careless tenant / botnet trying to burn Neon+Gemini spend or cause an outage.

> **Status note (2026-09-02, #1166):** see the "Remediation status" table in
> `docs/audits/2026-09-02-adversarial-audit.md` for the authoritative per-finding fixed/open state
> — the global AI quota finding below may already be closed (#1134 added a per-store slice).

## Severity tally

- P1: 1
- P2: 3
- P3: 2
- FALSIFIED: 0 prior PASS overturned outright; 2 prior findings confirmed FIXED (credit).
- UPHELD: single-flight cache, AI quota-before-spend on single calls, offset-skip cap.

---

### [P1] Public product search is an unbounded leading-wildcard ILIKE over 4 TEXT columns with no min-length and no trigram/FTS index — cache-key-varied to defeat every cache layer, turning a 30-byte GET into a full seq-scan of the products table

- **Where:** `apps/api/src/routes/public.routes.ts:143` (`GET /public/products`, `search` passed straight through) → `apps/api/src/services/product.service.ts:1146` `listPublic` → `buildProductSearchAnd` (`product.service.ts`, the `contains`/`mode:'insensitive'` block). Cache wrap at `public.routes.ts:206` (`getCached(cacheKey, 120, …)`), cacheKey built at `public.routes.ts:200-205` and **includes `search`**.
- **Attack:** unauthenticated loop of `GET /api/v1/public/products?search=<random>` with a **different** `search` token each request (`?search=a`, `?search=aa`, `?search=qx`, …), sending the store's `x-store-id`/`x-store-domain` header. Each distinct term is a fresh cache key → misses Redis AND the in-memory `BoundedMap` AND the single-flight registry (all keyed by the same string) → runs `WHERE storeId AND status AND deletedAt IS NULL AND (name ILIKE '%t%' OR nameAr ILIKE '%t%' OR description ILIKE '%t%' OR descriptionAr ILIKE '%t%')`.
- **Damage:** cost + capacity. `ILIKE '%token%'` on `description`/`descriptionAr` (large TEXT) cannot use any btree index; there is **no `pg_trgm`/GIN/FTS index anywhere** (verified: `grep -RIn 'USING gin|gin_trgm|pg_trgm|to_tsvector' packages/database/prisma/migrations` → empty). So every unique term is a sequential scan of the whole product table for that tenant. On Neon (compute-hours billing + autosuspend) sustained unique-term traffic (a) pins compute so it never autosuspends and (b) drives CPU → directly inflates the bill and starves the shared pool for real storefront reads. `publicLimiter` caps 300/min **per IP** only (`security.ts:351`), trivially beaten by a small IP pool; the amplification factor (attacker cost ≈ one short GET vs. server cost = one full-table ILIKE) is the point.
- **Evidence:** `product.service.ts` `buildProductSearchAnd` returns `{ name:{contains:token,mode:'insensitive'} , nameAr…, description…, descriptionAr… }` per token; no length floor on `token`. Route has **no** `search.length >= N` guard (contrast `/:storeId/search/suggest` at `public.routes.ts:922` which _does_ enforce `trimmed.length < 2 → []`). Cache key line embeds `${search || ''}`.
- **Why prior audits missed it:** `docs/audits/2026-07-12-scaling-cliff-reel.md` and `2026-07-02-scaling-perf.md` audited offset depth, exports and the resolve endpoint but never the search path; `2026-07-13-cache-stampede.md` reasoned about single-flight collapsing _identical_ keys and declared the product cache "single-flight-safe" — true, but single-flight and both cache layers are ALL keyed by the query string, so **distinct search terms bypass all three** and hit the DB every time. The stampede audit's own H1 note ("already wraps this whole method in getCached … single-flight-safe") is the false comfort here.
- **Blast radius:** same `getCached(key-includes-user-input, …)` amplification pattern applies to any `/public` cache key that folds in free-form input — `public:suggest:<storeId>:<q>` (`public.routes.ts:928`, mitigated by the `>=2` floor but still term-varied and also ILIKE), and category/option-filter permutations in the same products key (`optionFilterKey`, minPrice/maxPrice) which multiply distinct keys. The offset cap (`MAX_SKIP=10000`, `product.service.ts:1175`) is UPHELD and does NOT help here — search doesn't need depth.
- **Fix:** enforce a minimum search length (>=2, mirror the suggest route) AND add a `pg_trgm` GIN index on `name/nameAr` (+ optionally a `tsvector` for descriptions) so the ILIKE is index-backed; additionally cap the number of distinct uncached search keys per IP/tenant per window (or refuse to cache — and to run — searches below the floor).

---

### [P2] The global Gemini daily request cap (450/day) is shared across ALL tenants — one merchant's bulk sweep drains it and denies AI to every other store for the rest of the day

- **Where:** `apps/api/src/lib/ai-quota.ts:93` `assertAiQuota()` — the global-scope leg counts `prisma.aiUsage.count({ where:{ createdAt:{gte:startOfDay}, cachedHit:false }})` (`:103-105`) with **no `storeId` filter**; cap `DEFAULT_DAILY_REQUEST_CAP = 450` (`ai-quota.ts:67`). Called before every Gemini call in `ai.service.ts` (327/393/487/557/680), the accounting/answer-engine providers, and every bulk-AI Inngest fn. _(Line numbers corrected 2026-09-02, per #1158, against the file as merged in PR #1134, which also added a per-store daily slice layer above the global cap not reflected in this finding's original framing — see the function's own doc comment for the current layer order.)_
- **Attack:** a merchant with the `bulk_operations` feature (`ai.routes.ts:383+` gates `/bulk/*` on `requireFeature('bulk_operations')`) runs a bulk sweep (e.g. `POST /stores/:id/ai/bulk/seo`) over a catalog of >450 products. Each product = one non-cached Gemini call = one `aiUsage` row. Once 450 rows land in a day, `assertAiQuota()` throws `AI_QUOTA_DAILY_EXCEEDED` for **every** store on the platform — the translate button, palette-from-logo, category suggestions, answer-engine, accounting AI all 429 until 00:00 UTC.
- **Damage:** cross-tenant availability (noisy-neighbor DoS on a shared budget). The per-store `checkBudget` token budget (`ai.service.ts:137`) does NOT protect other tenants — it's per-store and it runs _after_ the global `assertAiQuota` gate. Attacker cost: one paid feature + one sweep of their own catalog. It is _enforced before spend_ (good) but the shared scope means the enforcement itself is the denial vector.
- **Evidence:** `assertAiQuota` query has no tenant predicate; comment at `ai-quota.ts:55-58` explicitly says "Global cap on Gemini calls per day … shared across all stores on this account … Protects the free-tier quota from a single bulk sweep blowing through it." The doc acknowledges the single-sweep drain but frames it as protection, not as the cross-tenant denial it also is. **Status (2026-09-02):** PR #1134 added a per-store daily slice (`DEFAULT_STORE_DAILY_REQUEST_CAP`, `ai-quota.ts:69-74`, comment cites this finding by name) beneath the global cap — re-verify whether this closes the finding before treating it as still open.
- **Why prior audits missed it:** the AI-cost audits treated the cap as a _protection_ and checked "is there a cap + is it before the call" (yes) — they did not attack it as a _shared_ budget one tenant can exhaust to starve others.
- **Blast radius:** every `assertAiQuota()` call site (28+ across `services/ai.service.ts`, `services/accounting/gemini-ai.service.ts`, `services/answer-engine/gemini.provider.ts`, all `lib/inngest/functions/bulk-ai-*.ts`). A merchant owning multiple stores multiplies the drain (bulk concurrency is `limit:1` **per storeId**, so N stores = N concurrent sweeps).
- **Fix:** add a per-tenant daily/monthly Gemini _request_ cap (not just the token budget) checked before the global cap, so a single store can consume at most its slice; reserve headroom in the global cap for interactive single-call features so a background bulk sweep can never zero out the whole platform's live AI.

---

### [P2] Suspending a store does NOT invalidate the storefront `store/resolve` cache — a suspended (fraud/non-payment) store keeps serving the full active storefront and taking checkouts for up to 120s

- **Where:** `apps/api/src/routes/store.routes.ts:609-618` — `PATCH /stores/:id/status` writes `store.status` then invalidates ONLY `featureService.invalidateCache(id)`. It never busts `public:store:resolve:<domain>` / `public:store:<slug>` / `public:store:<storeId>` (the caches that carry the `status` field), and never triggers the Next `revalidateTag('store-domain:…')` purge.
- **Attack:** super-admin suspends a store for fraud / chargebacks / non-payment. The domain→store resolve is served from `getCached('public:store:resolve:<domain>', 120, …)` (`public.routes.ts:1357`), whose cached object still has `status:'active'`. For up to 120s (Redis) the storefront renders the active shop instead of the suspended-maintenance page — customers can browse and **complete checkout/payment** on a store that was just cut off. The web layer adds its own 8s in-memory + 15s Next-tag window on top (`apps/web/src/lib/store-resolver.ts:183-227`), and that tag is not purged either.
- **Damage:** integrity/availability — account-status is a NEVER-stale value served from a TTL-only-invalidated cache (direct violation of the global `feedback-cache-invalidate-every-write-path` rule). A fraudulent/suspended merchant keeps transacting for the window; conversely reactivation is delayed the same way.
- **Evidence:** handler comment at `store.routes.ts:614-618` reasons only about the _feature_ cache ("store.status doesn't change the resolved feature map directly … reduces stale-state windows") and demonstrably omits the resolve/store caches that `select: { … status … }` at `public.routes.ts:1362`. The correct busting helper exists and is used on domain change (`store.routes.ts:1325` and `store.service.ts:38-40` `invalidateStoreCaches`) — it is simply not called from the status path.
- **Why prior audits missed it:** the cache-invalidation audits enumerated product/price/stock write paths; the _store status_ mutation was not treated as a cache writer. `store.service.ts:invalidateStoreCaches` exists specifically for this and the status handler bypasses it.
- **Blast radius:** any other writer of `store.status`/lifecycle that doesn't route through `invalidateStoreCaches` — check store soft-delete/archive paths and any Inngest job that flips status. The web `store-resolver` in-memory + Next-tag layers are a second stale surface for the same event.
- **Fix:** in the status PATCH call `invalidateStoreCaches(id, slug, domain)` (or at minimum `invalidateCached('public:store:resolve:<domain>')` + the slug/id keys) and fire the `revalidateTag` purge, exactly as the domain-change path does.

---

### [P2] Rate-limit store is fail-CLOSED on Redis outage: `passOnStoreError` is left default (false), so a Redis blip 500s every rate-limited route (auth, public, cart, payment, uploads, AI)

> **FIXED — #1134.** Every limiter in `security.ts` now sets `passOnStoreError: true` (verified: 13
> occurrences), matching the cache's existing fail-open posture.

- **Where:** `apps/api/src/middleware/security.ts:223` `makeRateLimitStore` builds a `RedisStore` whenever `redis.getClient()` is non-null; `getClient()` returns the client regardless of connection state (`redis.service.ts:71-73`, `isConnected` not checked). No limiter sets `passOnStoreError`, and express-rate-limit v8 defaults it to **false** (`node_modules/express-rate-limit/dist/index.cjs:850`, branch at `:930` rethrows when false).
- **Attack:** not attacker-triggered per se, but a Redis outage (Railway internal Redis restart, network blip after the 3 `maxRetriesPerRequest` are exhausted) makes `store.increment()` reject → express-rate-limit rethrows → Express error handler → 500 on **every** limited route. Storefront _reads_ fail-open (the `getCached` path swallows Redis errors, `public-cache.ts:44`), but auth/login, cart mutations, payments, uploads and AI all sit behind limiters and hard-500. Redis becomes a single point of failure for the whole write surface.
- **Damage:** availability — a dependency blip escalates to a full write/login outage instead of degrading to unlimited-but-up. Asymmetric with the deliberately fail-open cache layer, which shows the intent was fail-open.
- **Evidence:** `redis.service.ts` retryStrategy + `maxRetriesPerRequest:3` means commands eventually reject on a real outage; `getClient()` never returns null once constructed, so the `makeRateLimitStore` "return undefined when Redis unavailable" fallback (dev/test only) never fires in prod.
- **Why prior audits missed it:** F8 (Redis-backed limiter) was audited for the _horizontal-scale correctness_ win (shared counter) — the failure posture of the store wasn't attacked.
- **Blast radius:** all 12 limiter definitions in `security.ts` + the global limiter in `index.ts:295`. All share the same fail-closed default.
- **Fix:** set `passOnStoreError: true` on the limiters (fail-open to match the cache posture — availability over strict limiting during a Redis outage), or have `getClient()`/`makeRateLimitStore` return undefined when `!isConnected` so express-rate-limit falls back to its in-memory store instead of 500ing.

---

### [P3] Master sitemap fans out one API subrequest per store via `Promise.all` — unbounded in tenant count, will hit the Cloudflare Workers subrequest cap as the platform grows

- **Where:** `apps/web/src/app/sitemap.ts:168-174` — `Promise.all(stores.map(store => fetchProducts(store.id)))`; `fetchStores()` (`:31-52`) pages up to 50×100 = **5000 stores**.
- **Attack/trigger:** a cache-cold hit on `store.forcemediakw.com/sitemap.xml` (platform host branch). Each store = one `fetch` to `/public/products` → up to 5000 concurrent subrequests in one Worker invocation. CF Workers cap subrequests at 1000/request (50 on free) → the render throws past that ceiling and the `apex` fallback (declared after the fetch) is never returned; also drives a burst of API/DB load.
- **Damage:** sitemap render failure + API burst — availability, growth-gated. Currently low (small store count) and cached `revalidate:3600`, so not exploitable at will today.
- **Evidence:** no per-invocation store cap on the fan-out (only the 50-page store-list cap); `fetchProducts` requests `limit=1000` (server clamps to 100 via `Math.min(100,…)` in `listPublic`, so row count is bounded — the subrequest _count_ is not).
- **Fix:** cap the master sitemap at a bounded number of stores per render and/or use a sitemap index that shards per-store, so the Worker never issues an unbounded fan-out.

### [P3] Per-IP-only limiter keys; no per-tenant budget on shared public buckets

- **Where:** `security.ts` — `publicLimiter`, `storeResolveLimiter`, `couponValidateLimiter`, `promotionPreviewLimiter`, `viewIngestLimiter` key on IP only (default or `ipKeyGenerator`), in a single shared Redis bucket prefix per limiter. There is no per-`storeId` dimension, so the limiter bounds a single IP but not aggregate load against one tenant's expensive endpoints (feeds this into the P1 amplification: 300/min _per IP_ across a small IP pool is ample to sustain the seq-scan burn).
- **Damage:** defense-in-depth gap; the per-IP cap is the only volume bound on the P1 search path and on `/feed/products.json`, `/store/resolve`, etc.
- **Fix:** add a per-tenant token budget (keyed by resolved `storeId`) on the expensive public reads so no single store's shared budget can be exhausted regardless of source IP spread.

---

## UPHELD (attacked hard, could not break)

- **Offset-depth cliff:** `listPublic` hard-caps `skip` at `MAX_SKIP=10000` and validates `cursor` as a strict UUID (`public.routes.ts:157`, `product.service.ts:1175`). `?page=99999` cannot force a deep OFFSET scan. Solid.
- **AI quota-before-spend on single calls:** every interactive Gemini path calls `assertAiQuota()` + per-store `checkBudget()` _before_ the model call (`ai.service.ts:327/393/487/557/680`), and bulk sweeps re-check `assertAiQuota()` before each item with `concurrency:{key:storeId,limit:1}` + `AI_BULK_THROTTLE_MS`. The cap is real and pre-spend — the only gap is its _shared scope_ (P2 above), not its enforcement point.
- **Enqueue fail-fast:** bulk-AI enqueue wraps `inngest.send` in try/catch and calls `markJobFailedIfEnqueueFailed(job.id, err)` before returning 503 (`ai.routes.ts` bulk handlers) — no orphan `queued` row on enqueue throw, per the global rule. Webhook ingest is durable-first then enqueue-or-inline-fallback (`webhook.routes.ts:224-283`). Both UPHELD.

## Confirmed FIXED since prior audits (credit)

- `2026-07-13-cache-stampede.md` H1 (inner `listPublic` cache re-poisoning outer) — the inner cache is gone; `product.service.ts:1185-1191` documents the removal. Verified.
- `2026-07-12-scaling-cliff-reel.md` #2 (`invalidateCustomersCache` never called) — now has real call sites in `order.service.ts:1166`, `payment-confirm.service.ts:251/365`, `payment.factory.ts:744/1021/1195`. Verified.

## Blind spots (need runtime to settle)

- Whether `api.force-ai.co` is actually CF-proxied (edge cache honoring `setEdgeCache`) or naked Railway. If naked, the `sMaxAge`/SWR headers are inert and Redis `getCached` is the _only_ cache — which strengthens P1 (no edge layer to absorb term-varied misses). Settle with `curl -sI https://api.force-ai.co/api/v1/public/products` → look for `cf-cache-status`/`age`.
- Actual Neon compute cost of one `/public/products?search=<term>` under a realistic catalog — settle with `EXPLAIN (ANALYZE, BUFFERS)` on the ILIKE query at a few-thousand-row table.
- `TRUST_PROXY_HOPS` live value: if still `1` while `api.force-ai.co` is CF-proxied, `req.ip` collapses to the CF egress IP and every per-IP limiter becomes a single global bucket (would upgrade P1/P3). Settle by reading the Railway env + a request with a spoofed XFF.
