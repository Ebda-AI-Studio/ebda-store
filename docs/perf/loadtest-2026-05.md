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

| Date       | Scenario          | p95                           | Notes                                                                                                                                                                                          |
| ---------- | ----------------- | ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-05-02 | storefront-browse | 456ms (list) / 477ms (detail) | Single-IP run from local laptop. 18% requests 429'd by `100 req / 15min / IP` global limiter — expected for single-source tests. p95 is real-world for the requests that actually got through. |
| 2026-05-02 | api-bursts        | (pending)                     | Skipped — same single-IP rate-limit issue would dominate the result.                                                                                                                           |

## Single-IP rate-limit caveat

The global limiter at `apps/api/src/index.ts` caps `/api/` at 100
req per 15 min per IP — appropriate for production where users are
distributed across many IPs, but it dominates single-source load
tests within seconds. For meaningful stress tests, either:

- Run from k6 Cloud / multiple cloud regions (distinct IPs)
- Add a temporary `LOAD_TEST_BYPASS_TOKEN` header check on the
  limiter that's only set on Railway during a planned test window
- Sustain measurements at low VU counts (under ~5 from one IP)

The post-perf-pass numbers above are the real p95 for the requests
that _weren't_ rate-limited, so they reflect the API + DB + edge
performance honestly. The 18% failure rate is a measurement
artifact of single-IP testing, not a system problem.
