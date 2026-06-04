# Load tests

[k6](https://k6.io) scenarios for the Force Website Builder API.

## Install

```bash
brew install k6
```

## Run

Every scenario needs `STORE_ID` (a public storefront uuid). Defaults
to production; override with `BASE_URL` for staging.

```bash
STORE_ID=<uuid> ./run.sh storefront-browse
STORE_ID=<uuid> ./run.sh api-bursts
STORE_ID=<uuid> PRODUCT_SLUG=<slug> ./run.sh checkout-flow
STORE_ID=<uuid> ./run.sh all   # browse + bursts (skips checkout + multi-store-storm)

# Multi-store storm (requires seeded STORE_IDS — see section below):
STORE_IDS=$(cat loadtests/.loadtest-store-ids.txt) ./run.sh multi-store-storm
```

## Scenarios

| File                   | What it tests                                  | Profile                                             |
| ---------------------- | ---------------------------------------------- | --------------------------------------------------- |
| `storefront-browse.js` | Public read path: products, categories, detail | Ramp 25 → 50 VUs over 3 min                         |
| `api-bursts.js`        | Flash-sale spike on the cached list endpoint   | 200 req/s constant for 1 min                        |
| `checkout-flow.js`     | Guest checkout: cart → add → place             | Ramp 5 → 10 VUs (writes real orders, staging only!) |
| `multi-store-storm.js` | Cross-tenant concurrent load across N stores   | Ramp 50 → 100 VUs over 4 min (see below)            |

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
