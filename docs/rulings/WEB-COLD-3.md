# WEB-COLD-3

> Section: 2026-11-15 - storefront cold-start (G5)

Ruling WEB-COLD-3 (2026-11-15) - the Cloudflare build of `ebda-web` aliases `@sentry/nextjs` to `apps/web/src/lib/sentry-worker-stub.ts` for the SERVER graph only (`next.config.js` `turbopack.resolveAlias`, condition `browser` keeps the real SDK; Vercel/Node builds untouched). Evidence (measured, same method before and after: `node scripts/ci/worker-startup-budget.mjs --app web`, local workerd, min of 5): `cache-worker-entry.js` 22,813,353 B -> 16,070,960 B raw (-30%), 4,715,303 -> 3,221,014 B gzip (-32%); startup CPU 38.0 -> 38.6 ms (unchanged: the app is imported lazily). Cause: three components import `@sentry/nextjs`; the SSR of those client components pulled 3.7 MB of SDK + OpenTelemetry into the Worker script, yet the Next-server Sentry SDK is never initialised on the Worker (`cf-build.sh` moves `instrumentation.ts` aside; SSR errors go through `@sentry/cloudflare`), so every call was already a no-op. Budget: `scripts/ci/worker-startup-budget-web.json` (raw 16.6 MB, gzip 3.35 MB, CPU 90 ms; relative on PRs). Cost if wrong: server-side `Sentry.captureException/captureMessage/setTag/setContext` stay no-ops (as before); a new `Sentry.*` call on a server path added later is silently dropped until the stub gets that export (the stub's TS surface makes the build fail, not silently pass).

## WEB-COLD-4 - locale 308 cache

The cookie-less permanent 308 of `locale-redirect-edge.ts` is also stored in the Workers Cache API (key host + path + query, 60 s, `waitUntil`), so a cold isolate or another isolate in the same colo answers it with no resolver subrequest. Cookie visitors bypass it. BOUNDED-stale <= 60 s after a default-language change (the existing isolate-memo window); no extra purge hook (a purge-epoch check would cost the R2 read this removes). The browser copy stays `private, max-age=300` + `Vary: Cookie` (ICEBERG-EDGE-308-1). A Worker route cannot be edge-cached in front of the Worker, so the invocation itself remains; the redirect is cheaper, not free. Cost if wrong: <= 60 s of first visits to the previous language prefix, a real page in both languages.

## WEB-COLD-5 - Smart Placement and keep-warm: NOT enabled

Not measured, so not enabled. Smart Placement only helps a Worker whose time goes to round trips to one far backend; `ebda-web` fans out to the API, R2 and Durable Objects, and the effect can only be measured by an A/B on production traffic (it cannot be reproduced in local workerd). A keep-warm ping is synthetic traffic the resource-frugal rule forbids unless the measured win is large and the cost trivial; the cold tail here comes from fetching and compiling a script that was 22.8 MB (now 16.1 MB), so the cut is at the source. Re-open with: p95 of real-user TTFB before/after one week of the size cut (G17 baseline), then a one-week Smart Placement A/B on a single store if the tail persists. Cost if wrong: a residual cold tail on the first request per isolate stays until the data above says otherwise.

## WEB-COLD-6 - stale-while-revalidate for the cookie-less locale 308 (2026-11-17)

Ruling WEB-COLD-6 (2026-11-17) - a cached cookie-less locale 308 is served for up to 6 h (`REDIRECT_CACHE_STALE_S`); once it is older than 60 s it is still answered at once and re-decided from the resolver in `waitUntil`. Evidence (measured from the Mac, curl, ameliaaurum.com, 2026-11-17): after 11 min idle the `/` 308 hop took 3.2 s ttfb (about 0.5 s connect+TLS, the rest is the resolver: `GET api.ebda.app/api/v1/public/store/resolve` cold = handler 2.3 s, of which `auth-state` Durable Object 1.9 s over 8 calls and `store-do` 0.2 s; the same call warm = 0.17 s, 3 auth-state calls), while the next hop `/ar` (edge copy, STORE-EDGE-4) took 0.7 s total, and a repeat of the 308 0.37 s. So the cold first visit is the 308 resolver hop, not the page, not the Worker script: HEAD bundle 16.01 MB raw / 3.21 MB gzip, startup CPU 23 ms, against 16.07 MB / 3.22 MB at WEB-COLD-3 (no regression; budget `worker-startup-budget-web.json` unchanged). Cloudflare analytics for `ebda-web` (account GraphQL, 00:00-02:00Z): wall p50 0.4-7.5 s per 5-minute bucket at CPU p50 0.01-0.45 s, and 557 `api.ebda.app` subrequests at p50 1.08 s / p95 5.4 s: the time is waiting on the API, not computing. WEB-COLD-4 cached the 308 for 60 s, which an idle store's visitors never hit (a hard expiry in the Cache API), so every visit paid the resolver. Cache-class: the redirect target is BOUNDED-stale; after a merchant changes the default language the first visitor per data centre after the 60 s mark still gets the old prefix (a real, working page in that language), the refresh lands for the next, and nothing older than 6 h is served. The `x-redirect-at` header carries the age; an entry written by the previous version has none and is treated as a miss. Cost if wrong: one visitor per data centre per language change is sent to the previous language prefix; the cookie path and the 307 are untouched.

Residual, not fixed here (API side, measured): the resolver itself is 1.4-2.3 s cold because the public router's rate-limit hits go through the `AuthState` Durable Object (`middleware/public-limit-prefetch.ts`), and a Durable Object that has been idle is re-instantiated from storage. The same cold cost lands on any other uncached `api.ebda.app` call during a render. Next lever: let the Worker's store verdict skip the per-IP limiter (it is one trusted caller) or keep the DO warm; both need an A/B on production first (WEB-COLD-5 rule).

## WEB-COLD-3 (earlier measurement, 2026-11-11) - the slow first hit is a per-data-centre edge-cache MISS (a live render), not the Worker start; target NOT met

**Date:** 2026-11-11

**Decision:** no storefront code changes in this ruling. It records what makes the first hit slow, rules out the two suspects that were cheap to test, ships a repeatable probe (`scripts/ops/ttfb-probe.mjs`), and names the next fix. The "first hit under 1 s" target is NOT met by this change.

**Evidence (measured 2026-11-11 from Egypt, plain GETs to `storedemo.ebda.app`, new connection per request, Cloudflare IP pinned because the ISP blocks them):**

- `/ar` first hit in colo CDG: `x-demo-edge: MISS`, TTFB 5.05 s. The next two hits in the same colo: `HIT`, 1.46 s then 0.86 s. A later `/en` pair: first `MISS` in ZRH 1.52 s, then `MISS` again in CDG 2.96 s (the same client lands in a different data centre between requests, and each has its own empty `caches.default`).
- Warm, same colo, cache `HIT`: 0.36-0.58 s total of which about 0.5 s is this client's TCP + TLS to the colo, so the Worker adds little on a hit.
- `/health` (answered by the web Worker before Next, so no render, no API call): 0.37-0.41 s warm, 1.04 s and 0.88 s on first hits. `api.ebda.app/health` shows the same shape (0.37 s, 0.46 s, one 1.21 s) with `Server-Timing handler;dur=9`: the API handler is not the slow part. A first hit on `/health` that is 0.5 s slower than its siblings and never renders a page is the isolate start plus a new connection to a colo, a floor this code does not control.
- So there are two separate costs: about 0.5 s on a first hit to any colo (isolate start, network), and 2-5 s extra when the page itself is an edge MISS because that data centre has not rendered it for this build.

**Suspects tested and ruled out:**

1. Shared package side effects at Worker start (`packages/shared` has no `"sideEffects": false`, so a bundler must keep each barrel module's top-level code). Measured on the API Worker with `wrangler deploy --dry-run`, same `dist`, flag off vs on: 7,960,931 B vs 7,960,556 B (375 B). The bundler already drops the unused code; the flag buys nothing, so it was not added.
2. Data-cache-empty renders after a deploy: already fixed by WEB-COLD-2 (0.38-0.64 s locally with a filled data cache).

**Not measured here, and why:** the local Next/OpenNext cold-isolate render and the API startup CPU. The host was at load average 26 with 4.2 of 5 GB swap used (several agents' suites queued on the heavy-test lock), so local milliseconds were 4x inflated and noisy (API startup CPU 389-633 ms against a 99 ms baseline). A number from that would fail `benchmark-vet`. The web build was queued behind the lock and cancelled.

**Platform options checked (read-only, Cloudflare docs + `ttfb-probe.mjs`, 2026-11-11):**

- Smart Tiered Cache cannot help: `caches.default` (what DEMO-EDGE-1 and STORE-EDGE use) is local to one data centre and "does not interact with Tiered Cache" (Workers docs, "How the cache works"). The zone setting itself was not read (no zone-read token here); it would not matter for this layer.
- The OpenNext incremental cache (R2 + Durable Objects) is already global, but it holds fetch data and ISR output, not the HTML served by the edge layers; the data half is shared since WEB-COLD-2.
- Probe across data centres: `/en` MISS 3.66 s in MRS, then stale/cached 0.41-0.45 s in ZRH; `/ar/products` MISS 1.11 s in ZRH, then HIT 0.55 and 0.45 s. One render per page per data centre per deploy; a hit is already under 0.6 s.
- Single change that would get the first hit under 1 s: Workers Caching (`cache: { enabled: true }`, tiered by default, read-through, request collapsing) in place of `caches.default`. A MISS anywhere fills the upper tier. Plan: `docs/plans/2026-11-11-workers-caching-html.md`. It changes the price/stock staleness contract and has a platform blocker (compat date vs the pinned wrangler), so it is NOT implemented here.

**What would fix it (ranked, none done; item 1 below is superseded by the Workers Caching plan above):**

1. A second cache tier shared by all data centres for demo and listed-store HTML (R2 under `html/<build>/<host>/<path>`, validated by the existing per-store epochs in `store-edge-cache.ts`): a cold colo reads one R2 object instead of rendering. Touches the security-reviewed DEMO-EDGE-1 / STORE-EDGE rules (cache poisoning, per-visitor state), so it needs its own review and a deploy to measure; not attempted unverified.
2. Warm the colos real visitors hit, not only the CI runner's (`warm-storefront.mjs` reaches one colo): a scheduled probe from several regions after each deploy.
3. Smaller first render on a MISS: the critical chain is store resolve -> layout/featured/categories -> one batch; measure each hop with `Server-Timing` on a quiet host before changing it.

**Cost if wrong:** the first visitor per data centre per deploy still waits 2-5 s on a storefront page until fix 1 or 2 ships; the `/health` first-hit floor (about 0.5 s over warm) stays. Nothing here changes runtime behaviour, so there is no rollback.
