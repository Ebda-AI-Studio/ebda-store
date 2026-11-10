# RESOLVE-BULLETPROOF-1

> Section: 2026-11-10 — launch eve, store-resolution incident (plan `docs/plans/2026-11-10-resolve-bulletproof.md`)

**Ruling RESOLVE-BULLETPROOF-1 (2026-11-10) - storefront host -> store resolution is cached in two epoch-invalidated
layers and survives API failure; an API blip can no longer produce an error page for a store we have seen.**

Decision:

1. `apps/web/src/lib/store-resolve-cache.ts` owns resolve caching: per-isolate memory of hits (60 s) AND definitive
   misses (30 s), a durable R2 last-known-good (`resolve-lkg/<host>` in `NEXT_INC_CACHE_R2_BUCKET`) shared by every
   isolate, in-isolate coalescing, stale-if-error up to 24 h, one jittered retry (150-400 ms) only when no copy exists,
   never on a 404. Without R2 (next dev/start) the memory TTLs are 8 s / 15 s.
2. The resolve fetches leave the Next data cache (`cache: 'no-store'`). OpenNext's default `tagCache` is `"dummy"`
   (we configure only `incrementalCache`), so the `store-domain:<host>` purge never reached it: a suspended store stayed
   resolvable for the 15 s TTL plus one stale serve.
3. NEVER-stale (status, domain/slug ownership, plan entitlement): every serve, including stale-if-error, first checks the
   purge epochs (`all`, `host/<host>`, `id/<storeId>`) the Worker writes on `/api/revalidate` (STORE-EDGE-1). A copy
   older than a purge is never served, not even during an outage (503 instead).
4. `bustStoreCaches` now purges the PREVIOUS slug/domain too (API resolve key, CORS, storefront tags); before, a removed
   or changed domain waited out the 120 s TTL (audit 2026-07-12 finding #1).
5. Nothing usable -> the store-unavailable render (HTTP 500, digest `STORE_TEMPORARILY_UNAVAILABLE`) is rewritten at
   the edge to 503 + `Retry-After: 30`, `private, no-store` (`apps/web/resolve-unavailable-edge.ts`, wired in
   `serveDemoEdge`); edge HTML caches store only 200s.
6. Edge verdicts (`storeVerdict`, `isDemoStoreHost`) keep their last verdict on a 429/5xx/network error.
7. Alert: >= 10 upstream resolve failures per isolate per 60 s -> one `[resolve-degraded]` console.error (Workers logs
   / logpush) + `Sentry.captureMessage` (error) per window.

Evidence (measured 2026-11-10): `store-resolve-bulletproof.test.ts` 19 tests; each of 10 layer mutations turns >= 1 red.
Local `next start` + mock API at the incident limit (30/min global, 10 % 503s): 601 loads, demo hosts 100 % rendered,
0 unexpected 5xx; 24 unknown-host loads were the store-unavailable render (503 at the edge). Without the limiter, 1201
loads, 0 failures, 287 resolve calls.

Residuals: the 2 s epoch memo (NZ-D3); during an outage a copy up to 24 h old is served when no purge happened in
between (a purge the API failed to deliver is then invisible for that window); a never-seen host has nothing to fall
back on, so a drained bucket still answers it 503 (layer 1, PR #514, removes the shared bucket); the alert is per
isolate and its delivery to a pager depends on the Sentry alert rules (not verified here). Out of scope, same dummy
tagCache: the crawler/feed routes `sitemap.ts`, `robots.ts`, `llms.txt`, `feeds/products.json` and
`agent-store-resolver.ts` still call the resolver through the Next data cache (600-3600 s, TTL-bounded only); they
render no shopper page and a failure there is not an error page, so they stay BOUNDED-stale at those TTLs.

Cost if wrong: a merchant suspended or a domain removed during an API outage whose purge never reached the storefront
keeps resolving from the last-known-good copy for up to 24 h.
