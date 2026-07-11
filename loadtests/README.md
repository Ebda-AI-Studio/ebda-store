# Load tests

[k6](https://k6.io) scenarios for the Force Website Builder API.

## Install

```bash
brew install k6
```

## Run

Every scenario needs `STORE_ID` (a public storefront uuid). Defaults
to production; override with `BASE_URL` for staging. **Exception:
`lens-n-medium-traffic.js` has no production default** — it's a heavier
storm (up to 400 VUs across ~80 tenants) that must run against staging or
a dedicated load environment, so `BASE_URL` is required.

```bash
STORE_ID=<uuid> ./run.sh storefront-browse
STORE_ID=<uuid> ./run.sh api-bursts
STORE_ID=<uuid> PRODUCT_SLUG=<slug> ./run.sh checkout-flow
STORE_ID=<uuid> ./run.sh all   # browse + bursts (skips checkout + multi-store-storm)

# Multi-store storm (requires seeded STORE_IDS — see section below):
STORE_IDS=$(cat loadtests/.loadtest-store-ids.txt) ./run.sh multi-store-storm

# Lens N — medium-traffic headroom across ~80 stores (requires seeded
# STORE_IDS + an explicit staging/load BASE_URL — see section below):
STORE_IDS=$(cat loadtests/.loadtest-store-ids.txt) \
BASE_URL=https://<staging-host>/api/v1 \
./run.sh lens-n-medium-traffic
```

## Scenarios

| File                       | What it tests                                                     | Profile                                                   |
| -------------------------- | ----------------------------------------------------------------- | --------------------------------------------------------- |
| `storefront-browse.js`     | Public read path: products, categories, detail                    | Ramp 25 → 50 VUs over 3 min                               |
| `api-bursts.js`            | Flash-sale spike on the cached list endpoint                      | 200 req/s constant for 1 min                              |
| `checkout-flow.js`         | Guest checkout: cart → add → place                                | Ramp 5 → 10 VUs (writes real orders, staging only!)       |
| `multi-store-storm.js`     | Cross-tenant concurrent load across N stores                      | Ramp 50 → 100 VUs over 4 min (see below)                  |
| `lens-n-medium-traffic.js` | Medium-traffic headroom across ~30-80 stores + `/health` + layout | Ramp to 200-400 VUs (default 300) over ~7 min (see below) |

### Multi-store storm

The single-`STORE_ID` scenarios don't exercise **cross-tenant contention** on
the shared Neon pool or the per-request RLS `runInTenantContext` GUC-set path.
`multi-store-storm.js` distributes each VU iteration across a random store from
`STORE_IDS`, producing simultaneous `SET app.current_store_id` + RLS policy
evaluation from 100 VUs hitting up to 20 different tenants at once.

#### 1. Seed disposable test stores

```bash
# From repo root (default: 20 stores)
npm run seed:loadtest --workspace @force/database

# Override store count
LOADTEST_STORE_COUNT=10 npm run seed:loadtest --workspace @force/database
```

The seeder is idempotent: re-running it reuses existing `loadtest-store-NNN`
stores. On completion it writes `loadtests/.loadtest-store-ids.txt` (gitignored)
with a comma-separated line of store UUIDs.

#### 2. Run the scenario

```bash
STORE_IDS=$(cat loadtests/.loadtest-store-ids.txt) ./run.sh multi-store-storm

# With rate-limit bypass (recommended for honest measurements — see below):
STORE_IDS=$(cat loadtests/.loadtest-store-ids.txt) \
LOAD_TEST_TOKEN=<same-value-as-LOAD_TEST_BYPASS_TOKEN> \
./run.sh multi-store-storm
```

#### 3. Clean up after testing

```bash
npm run seed:loadtest:cleanup --workspace @force/database
```

This deletes all `loadtest-store-*` stores (and their products/categories) and
the `loadtest+stores@forcemediakw.com` user. Safe to run multiple times.

#### Env knobs

| Variable               | Default    | Description                                   |
| ---------------------- | ---------- | --------------------------------------------- |
| `STORE_IDS`            | (required) | Comma-separated store UUIDs from the seeder   |
| `BASE_URL`             | production | Override with staging API base URL            |
| `LOAD_TEST_TOKEN`      | (unset)    | Rate-limiter bypass token (see section below) |
| `LOADTEST_STORE_COUNT` | `20`       | How many stores to create during seeding      |

### Lens N — medium-traffic headroom (~30-80 stores)

Closes the "Lens N" load-testing gap: the storefront's ~30-80-store
medium-traffic headroom was previously _reasoned_ (edge cache + covering
indexes should hold) but never _measured_. `lens-n-medium-traffic.js` is
that measurement, and the "load" layer of the project's 5-layer testing
standard (unit / integration / e2e / load / uat) for this specific claim.

**This is a TEST ARTIFACT with a documented p95 ceiling — it must run
against staging or a dedicated load environment, NEVER production live
stores.** Unlike the other scenarios, `BASE_URL` has no production
default; you must set it explicitly.

**Traffic model.** Each VU iteration picks a random store from `STORE_IDS`
(same pattern as `multi-store-storm.js`) and mixes the hottest public read
paths in roughly real-shopper proportions:

- `GET /public/products` — always (product list, the highest-volume read)
- `GET /public/categories` — 60% of iterations (category strip)
- `GET /public/stores/:storeId/layout` — 40% of iterations (homepage
  section config, fetched once per page load)
- `GET /public/products/:slugOrId` — 30% of iterations (product detail,
  resolves a real slug from that store's list response first)
- `GET /health` — 5% of iterations (a small slice modeling uptime-monitor
  probes that hit the platform continuously regardless of shopper
  activity; mounted at the app root, not under `/api/v1`)

**VU profile — why 300 peak / ~80 stores.** Ramp 1m → 100 VUs (warm-up),
2m → 300 VUs (ramp to peak), hold 3m at 300 VUs (this is where headroom is
actually measured), 1m ramp-down. At the default 80 seeded stores, 300 VUs
is ~3.75 concurrent VUs per store at peak — comparable to several dozen
small-to-mid Kuwait/GCC storefronts each seeing a handful of concurrent
shoppers simultaneously. That's deliberately a step below a single-store
flash-sale spike (`api-bursts.js` already covers that extreme at 200 req/s
constant-arrival) and a step above `multi-store-storm.js`'s default
50→100 VU / 20-store regression profile — "medium traffic," not a ceiling
stress test. Override the peak with `LENS_N_MAX_VUS` and the hold duration
with `LENS_N_HOLD` to explore further (e.g. `LENS_N_MAX_VUS=400` for the
top of the documented 200-400 VU medium-traffic range).

**Thresholds.**

| Metric                                                                            | Threshold | Why                                                                                                                                                                                                                                                                                                                                                                                |
| --------------------------------------------------------------------------------- | --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `http_req_failed`                                                                 | rate<1%   | Standard error-budget floor used across every scenario in this suite.                                                                                                                                                                                                                                                                                                              |
| `http_req_duration` (overall p95)                                                 | <500ms    | The code-quality non-negotiable ("fix p95 > 500ms before ship") for the edge-cached public read path.                                                                                                                                                                                                                                                                              |
| `ms_product_list` / `ms_category_list` / `ms_product_detail` (p95, informational) | <800ms    | Matches the ceiling `multi-store-storm.js` already established for cross-tenant RLS/GUC-set contention — `docs/perf/loadtest-2026-05.md` shows ~500-520ms at just 50 VUs on a SINGLE store, so 500ms isn't realistic once ~80 stores' RLS overhead stacks on the shared Neon pool at once. Informational (not hard-failing) per-endpoint so one slow path doesn't mask the others. |
| `ms_store_layout` (p95, informational)                                            | <500ms    | Edge-cached (`s-maxage=120`) — should stay close to the general ceiling.                                                                                                                                                                                                                                                                                                           |
| `ms_health` (p95, informational)                                                  | <200ms    | A single `SELECT 1` — should be near-instant even under load.                                                                                                                                                                                                                                                                                                                      |

**Interpreting results → the measured headroom.** After a run, `k6`'s
summary reports the actual p95/p99 per metric and the achieved
iterations/s. If the overall `http_req_duration` threshold passes at 300
VUs across 80 stores, that IS the measured headroom claim — re-run with
`LENS_N_MAX_VUS` stepped up (350, 400, 500...) until a threshold trips to
find the actual ceiling, and record the numbers in
`docs/perf/loadtest-2026-05.md` alongside the existing baseline entries
(date, scenario, p95, failure rate, notes on VU count and store count).
A failing run at the documented 300-VU/80-store profile means the
"reasoned, not measured" headroom claim doesn't hold — treat it the same
as any other p95 > 500ms regression per the code-quality rule.

## Targets and thresholds

The thresholds are calibrated for the post-perf-pass setup:

- Edge cache (`apps/api/src/lib/edge-cache.ts`)
- New covering indexes (`20260501030000_perf_indexes`)
- Inngest fan-out (no inline SMTP / OneSignal on the request path)

A failing run usually means something regressed in one of those
three areas. Re-baseline `docs/perf/loadtest-2026-05.md` after any
change that affects the public read path.

## Don't run checkout against production

`checkout-flow.js` creates real orders. Use a disposable test store
on staging, or accept that you're filling production with
`LoadTest Buyer` orders that need cleaning up.

## Bypassing the rate limiter for honest measurements

The API caps `/api/` at 100 req per 15 min per IP. From a single
laptop a load test trips this within seconds and the bulk of the
results become 429s — making the timings meaningless.

To get an honest measurement:

1. Set `LOAD_TEST_BYPASS_TOKEN` on Railway (long random value):
   ```bash
   railway variables --service api --set "LOAD_TEST_BYPASS_TOKEN=$(openssl rand -hex 32)"
   railway redeploy --service api
   ```
2. Run the test with the same token:
   ```bash
   STORE_ID=<uuid> LOAD_TEST_TOKEN=<same value> ./run.sh storefront-browse
   ```
3. **Unset the token after the test** so production traffic
   can't bypass the limiter:
   ```bash
   railway variables --service api --unset LOAD_TEST_BYPASS_TOKEN
   railway redeploy --service api
   ```

The k6 scenarios automatically forward `LOAD_TEST_TOKEN` as the
`x-load-test-token` header when set; the API checks
`process.env.LOAD_TEST_BYPASS_TOKEN` and skips the global limiter
on a match.
