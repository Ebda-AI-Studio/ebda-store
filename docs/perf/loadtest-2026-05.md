# Load Test Baseline — 2026-05-01

Baseline captured against production after the 5-phase perf pass
landed (audit-log archive, edge cache, covering indexes, Inngest
fan-out for order/created + bulk import + invoice email).

Hardware in play:

- API: Railway 1 GB / shared CPU
- DB: Neon free tier with Vercel edge in front
- Storefront cache: Vercel edge (s-maxage=60–120, swr=300–600)

## Scenarios

Run from `loadtests/` — see the README. Pick a high-traffic store id
that exists in production for representative cache behaviour.

```bash
STORE_ID=<uuid> ./run.sh storefront-browse
STORE_ID=<uuid> ./run.sh api-bursts
```

## Expected baseline (post-pass)

`storefront-browse` (ramp 25 → 50 VUs, 3 min):

| Metric                | Target  | Notes                              |
| --------------------- | ------- | ---------------------------------- |
| http_req_duration p95 | < 400ms | edge cache hits should land < 50ms |
| http_req_failed rate  | < 1%    | tolerates one-off DB blips         |
| iterations/s          | > 60    | with `sleep(1-3)` think-time       |

`api-bursts` (200 rps constant, 1 min):

| Metric                | Target   | Notes                             |
| --------------------- | -------- | --------------------------------- |
| http_req_duration p95 | < 500ms  | most served from edge             |
| http_req_duration p99 | < 1500ms | first request per VU misses cache |
| http_req_failed rate  | < 5%     | rate limiter trips above this     |

`checkout-flow` (ramp 5 → 10 VUs, 3 min, **staging only**):

| Metric                | Target   | Notes                                       |
| --------------------- | -------- | ------------------------------------------- |
| http_req_duration p95 | < 2500ms | order create now ~600ms faster post-Inngest |
| http_req_failed rate  | < 2%     |                                             |

## When to re-run

- Before any production deploy that touches the public read path
- After Prisma migrations that add or drop indexes
- When considering plan changes (Railway tier, Neon scale up)
- After Vercel edge config changes (cache TTLs, Vary tokens)

## Recording results

When the numbers shift materially, capture them inline below with
the date and a one-line note about what changed.

| Date       | Scenario          | p95                                    | Failure rate | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ---------- | ----------------- | -------------------------------------- | ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-05-02 | storefront-browse | list 502ms / detail 521ms / cats 484ms | 0%           | Honest baseline — 50 VUs ramp over 3 min with `LOAD_TEST_BYPASS_TOKEN` set so the per-IP limiters don't dominate the result. avg 317ms, max 891ms. 4732 requests, all 200. p95 is above the 400ms aspirational threshold but well within usable territory; sort-cost on the new `(store_id, deleted_at, created_at DESC)` index keeps tail latency from blowing up under load.                                                                       |
| 2026-05-02 | api-bursts        | 4.63s                                  | 0%           | Constant 200 req/s for 1 min. **Achieved throughput: 81 req/s** — beyond that requests queue and tail latency climbs; 6723 iterations were dropped because the runner couldn't sustain 200 req/s. avg 2.17s, max 13.7s. Single Railway 1 GB instance is the bottleneck — to sustain 200+ req/s on the cached read path we'd need either Pro plan, more replicas, or a cold-cache fix (currently most Vercel edge keys miss for an unknown store id). |

Earlier (rate-limited) run for reference:

- 2026-05-02 storefront-browse first attempt — 18% 429s (single-IP global limiter), p95 list 456ms / detail 477ms — measurement artifact, not a system problem.

## Honest measurements need the bypass token

The per-route limiters in `apps/api/src/middleware/security.ts`
(public 60/min, write 30/min, payment 10/min, etc.) dominate
single-source load tests within seconds. Bypass workflow:

```bash
# 1. Set the bypass token on Railway
TOKEN=$(openssl rand -hex 32)
railway variables --service api --set "LOAD_TEST_BYPASS_TOKEN=$TOKEN"
railway redeploy --service api

# 2. Run the test with the same value
STORE_ID=<uuid> LOAD_TEST_TOKEN=$TOKEN ./loadtests/run.sh storefront-browse

# 3. Unset and redeploy when done
railway variables --service api --unset LOAD_TEST_BYPASS_TOKEN
railway redeploy --service api
```

The skip is gated on the env var existing AND a header match — unset env = no bypass possible. Always unset after the test window so production traffic stays rate-limited.
