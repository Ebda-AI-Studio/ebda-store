# Ruling WEB-COLD-2 - the storefront data cache survives a deploy

**Date:** 2026-11-10

**Decision:** the storefront's Next fetch (data) cache entries are stored in R2 under ONE build-independent key space (`incremental-cache/shared-fetch/<sha256>.fetch`) instead of under the build id. Pages, route handlers and composable entries stay build-scoped. Code: `apps/web/shared-fetch-cache.ts` (the stock `r2IncrementalCache` with only `getR2Key` replaced), wired by `scripts/cf-setup-local.sh` (the `OPENNEXT_CACHE=true` config that deploys). `scripts/ci/populate-r2-cache.mjs` no longer uploads build-time fetch entries (they would overwrite a newer runtime entry under the shared key, stamped as fresh). The warm step (WEB-COLD-1) now runs `scripts/ci/warm-storefront.mjs`: home, `/products` and one product page per demo store and language, a 5xx or network failure retried once, both attempts logged.

**Evidence (measured 2026-11-10, local OpenNext production build on `wrangler dev`, real `api.ebda.app`, fetch timing logged per call):**

- Cold isolate + EMPTY data cache (= every first render after a deploy before this ruling): `/ar` 3.7-10.3 s, `/en` 3.1-6.8 s across the five demo stores, 5-7 API calls on the critical path (resolve -> layout + featured + categories -> one batch). Example jasmine/ar 7.6 s = resolve 4.4 s, then layout 2.0 s, then the batch 0.8 s; render itself ~0.2 s.
- Cold isolate + FILLED data cache: 0.38-0.64 s for all ten store/language pairs, 0 API calls on the critical path.
- Across builds (the actual deploy case): build A filled the cache, build B (new BUILD_ID) rendered cold from it: jasmine/ar 0.40 s, lamma/en 0.38 s, dahab/ar 0.38 s; the same build B with an empty cache: 3.8 s and 2.0 s.
- Arabic is not slower than English in itself: the deploy warm step always requested `/ar` first, so `/ar` paid each store's first-render cost (dahab/en was slower than dahab/ar when it happened to run against a colder API).
- API `Server-Timing` on a public read cache miss: `handler` 600-3100 ms, of which `auth-state` (AuthState Durable Object round trips, up to 9 serial calls) 380-2470 ms. That is the remaining cost for a truly empty cache (a new store, an evicted entry) and is the API's to fix.

**Why it is safe:** the key is Next's own fetch-cache key hash (URL, method, headers incl. `X-Store-ID`, body, Next's cache-key version), so tenants, API hosts and Next versions never share an entry (#696 test still pins the header half). The sharded Durable Object tag cache is not build-scoped, so a `revalidateTag` recorded under any build still marks a carried-over entry stale. Every call site keeps its own `revalidate` + tags; `cache: 'no-store'` reads never touch this cache.

**Footprint:** no new binding or service; R2 objects for fetch entries stop being duplicated per build (fewer writes). Warm step: 5 hosts x 2 languages x 3 pages = 30 GETs + 5 API reads per deploy (was 10 GETs), cap 22 min for the worst case (all timeouts), typically under a minute.

**Cost if wrong:** a deploy that ships code expecting a NEW field in an API response reads the previous JSON shape for at most that fetch's `revalidate` window (15-300 s) plus one request; such a change must default the missing field (it already must, because the API deploys separately). Production R2 GET latency is not in the local numbers (local R2 is in-process): expect up to a few hundred ms more per dependency level until a regional cache sits in front of R2.
