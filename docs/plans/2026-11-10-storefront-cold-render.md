# Storefront cold render (PERF-LATENCY, 2026-11-10)

**Must work:** cold first load of every demo store (`/ar`, `/en`) <= 2.5 s TTFB on a local production build; no 5xx left unlogged/unretried in the deploy warm step.
**Exercised:** demo home `/ar` `/en` x 5 stores on a local OpenNext build (`wrangler dev`, real `api.ebda.app`), fetch timings logged per call; the warm script against production (read-only GETs).
**Must NOT change:** cache class of any call site (revalidate + tags as they are; `no-store` reads untouched), page/HTML caches stay build-scoped, tenant keying of the fetch cache (#696), files owned by other PRs (`sentry-worker-entry.ts` client-IP parts, `ssr-client-address.ts`, `store-resolver.ts`, `apps/api/src/worker.ts`, `apps/api/src/middleware/security.ts`).
**Done:** PR open and green; before/after numbers in the PR body; ruling WEB-COLD-2 recorded.

## Findings (measured)

1. A cold render is ~95% API wait: resolve -> (layout || featured || categories) -> one batch. Render CPU ~0.2 s.
2. After a deploy the Next data cache is EMPTY: OpenNext's R2 cache keys every entry by build id. So every first render after a deploy pays the whole API chain (3.7-10.3 s locally, 12.1 s in the warm step).
3. Arabic is not slower per se: the warm step requested `/ar` first per store.
4. API public reads on a cache miss spend 380-2470 ms in serial AuthState DO calls (`Server-Timing: auth-state`) - API-side, out of scope here.

## Steps

1. `apps/web/shared-fetch-cache.ts`: stock R2 cache, fetch entries under a build-independent segment. Test: `tests/unit/web-shared-fetch-cache.test.ts` (red against the stock cache).
2. Wire it in `scripts/cf-setup-local.sh` (deploying config) + the committed `open-next.config.ts`.
3. `populate-r2-cache.mjs`: stop uploading build-time fetch entries (would overwrite newer runtime data). Test updated.
4. Warm step -> `scripts/ci/warm-storefront.mjs` (home + listing + PDP, both languages, retry once on 5xx, logged). Test: `tests/unit/web-deploy-warm.test.ts`.
5. Measure before/after cross-build locally; ruling WEB-COLD-2.
6. Controller review: key the shared namespace by a DATA-CONTRACT hash (`scripts/ci/fetch-contract-version.mjs`, baked by `cf-setup-local.sh`), so a shape change starts fresh; prove tag purges reach carried-over entries with the real adapter + tag cache. Tests: `web-fetch-contract.test.ts`, `web-shared-fetch-cache.test.ts`, `cf-cache-bindings-assert.test.ts`.
