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
STORE_ID=<uuid> ./run.sh all   # browse + bursts (skips checkout)
```

## Scenarios

| File                   | What it tests                                  | Profile                                             |
| ---------------------- | ---------------------------------------------- | --------------------------------------------------- |
| `storefront-browse.js` | Public read path: products, categories, detail | Ramp 25 → 50 VUs over 3 min                         |
| `api-bursts.js`        | Flash-sale spike on the cached list endpoint   | 200 req/s constant for 1 min                        |
| `checkout-flow.js`     | Guest checkout: cart → add → place             | Ramp 5 → 10 VUs (writes real orders, staging only!) |

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
