# Ruling PERF-PLACEMENT-1 - Smart Placement for ebda-api stays OFF until the "on" arm is measured

**Date:** 2026-11-11

**Decision:** `apps/api/wrangler.jsonc` keeps no `placement` block. The A/B the neon-zero plan (N-21) asked for after the Hyperdrive removal could only be half run: the "off" arm was measured live (read-only), the "on" arm needs a Worker with `"placement": { "mode": "smart" }` and there is no staging or preview API (docs/DEPLOYMENT.md "Environments & staging posture": none exists) and deploys were out of scope for this task. A Worker's placement is a deploy-time setting, so it cannot be toggled on the live Worker for a test.

**Evidence (measured 2026-11-11, 90 s, 3 iterations/s (2 requests/s: 1 in 3 a cache-hit read, 1 in 3 a cache-miss read, the third an idle pacing slot) with a unique query string, `GET /api/v1/public/products?limit=12`, demo store `storedemo`, k6 `hosts` override to a Cloudflare IP, client in Egypt, 180 requests, 0 failed):**

| arm                                  | path       | p50          | p95          |
| ------------------------------------ | ---------- | ------------ | ------------ |
| off (live, no `cf-placement` header) | hit        | 166 ms       | 249 ms       |
| off                                  | miss       | 183 ms       | 267 ms       |
| on                                   | hit / miss | NOT MEASURED | NOT MEASURED |

Write endpoints were not measured in either arm: no write is sent to production, and no preview exists to send one to.

**Why not flip it on the strength of the plan alone:** the only prior measurement (2026-10-22, PR #136, Postgres stack) made KV-hit calls slower (1.2 s to 2.3 s, n=6) because placement put the Worker at EWR; the 2026-11-02 plan says a cache hit pays the remote hop either way. Nothing measured since contradicts that, and the "off" numbers above leave little to win (hit and miss differ by about 20 ms because the store DO / D1 reads are already short).

**To finish (the harness is ready):** deploy a throwaway copy of `ebda-api` with placement on under another name (bindings to a seeded preview store, never the production D1/DO), then run the same file for each arm and compare p50 / p95 per path:

```
ARM=off BASE_URL=https://<off-host>/api/v1 STORE_ID=<uuid> HOSTS="<host>:<ip>" k6 run loadtests/scenarios/placement-ab.js
ARM=on  BASE_URL=https://<on-host>/api/v1  STORE_ID=<uuid> HOSTS="<host>:<ip>" k6 run loadtests/scenarios/placement-ab.js
```

Enable only if the miss path wins by more than the run-to-run spread without hurting the hit path, and read `cf-placement` from the deployed Worker (the script counts it as `ab_placed_responses`). Add the arm numbers to this file in the PR that flips it.

**Cost if wrong:** leaving it off keeps today's behaviour (hit p50 about 170 ms from here); if placement would have cut the miss path, we pay that gap on every miss until the arm is run. Turning it on unmeasured could repeat the 2026-10-22 slowdown on every hit.
