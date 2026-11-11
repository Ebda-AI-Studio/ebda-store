# Ruling WEB-COLD-3 - the slow first hit is a per-data-centre edge-cache MISS (a live render), not the Worker start; target NOT met

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
