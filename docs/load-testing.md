# Load testing (k6 on GitHub-hosted runners)

Ruling SCALE-READY-1 #7 (NEON-FOLD-1). Load tests never run on the Mac. Use the `load-test` workflow
(`.github/workflows/load-test.yml`, `EBDA_RUNS_ON` switch (unset = ubuntu-24.04 hosted), k6 pinned to 2.3.0) via Actions > load-test > Run workflow,
or call it from another workflow with `uses: ./.github/workflows/load-test.yml`.

| Input                  | Meaning                                                                                                                             |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `base_url`             | API root including `/api/v1` (a PR preview or prod). https only.                                                                    |
| `scenario`             | `smoke` (constant `rps` on `paths`), `storefront-mix` (browse + cart over `store_ids`), `flash-sale` (one store, cart-add at `rps`) |
| `duration`, `rps`      | defaults `60s`, `200`                                                                                                               |
| `p95_ms`, `error_rate` | thresholds, defaults `500` and `0`; the job fails when either is breached                                                           |
| `allow_prod`           | `flash-sale` against `*.ebda.app` is refused unless `true`                                                                          |

Safety: `flash-sale` stops after add-to-cart and a cart read. No scenario places an order or touches payment.
Seed or pick a disposable store for the cart scenarios; they create real carts.

Output: `k6-results` artifact (`k6-summary.json`, `k6-output.txt`) and a summary in the job summary.
Script: `tests/load/ebda-load.js`. The older local scenarios in `loadtests/` are unchanged.
