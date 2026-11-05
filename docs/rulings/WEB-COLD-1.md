# Ruling WEB-COLD-1 - warm the demo storefronts after every web deploy

**Date:** 2026-11-05

**Decision:** `cf-web-deploy.yml` ends with a best-effort step (`continue-on-error`, 3 min cap) that sends ONE plain GET of `https://<label>.ebda.app/ar` for each demo host in `apps/web/src/lib/demo-hosts.ts` and logs status/TTFB. No code path was changed: the render is already parallel where it can be.

**Evidence (measured 2026-11-05, plain GETs of public pages):** warm, cache-busted (uncached render) `/ar` TTFB 0.7-3.8 s across the five demo hosts; API `/health` 1.43 s, 0.65 s, 0.37 s on consecutive calls (cold -> warm). A cold first page after a deploy was reported at 10-13 s. Read from `HomePageBody.tsx` / `layout.tsx`: the dependency chain is store resolve -> (layout || featured || categories) -> one `Promise.all` of up to 9 reads -> the featured fallback only when no product is featured. Every hop is a call to `api.ebda.app` and can land on a cold API isolate / Durable Object / D1 read, and the Next data cache (`revalidate: 60`) is empty after a deploy, so the first request pays all of them plus the new Worker isolate. The layout-dependent batch cannot start earlier without speculative requests (more load every request), so it was left alone.

**Footprint:** 5 GETs and about 15-60 s of one runner step per web deploy; no extra cost.

**Cost if wrong:** the warm-up only helps the colo and isolate the runner reaches; other colos still pay one cold render, and it does not fix a slow API read. If the post-deploy log still shows a first-hit TTFB above 5 s, read the API `Server-Timing` (`db-wait`, `handler`) on that request to find the slow read.
