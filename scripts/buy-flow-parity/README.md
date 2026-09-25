# Buy-flow parity harness

Answers one question with evidence: **does this change alter what happens when a
customer buys?** It runs the same deterministic buy scenarios against two git refs
and diffs the outcome field by field. Identical output means the change does not
influence ordering or payment. Any difference is printed as a field path with the
base and head values.

The default baseline is `96814545`, the code real customers bought on
(pecannbee MyFatoorah orders, 2026-09-18..24, all completed).

```bash
npm ci                                                  # once, for this checkout
node scripts/buy-flow-parity/run.mjs --head <ref>       # base defaults to 96814545
node scripts/buy-flow-parity/run.mjs --base <ref> --head <ref>
node scripts/buy-flow-parity/run.mjs --list             # scenario ids
node scripts/buy-flow-parity/run.mjs --head pr-1234 --only guest-cod-fee-fixed-coupon,cod-cancel-restock
```

Exit code: `0` all PASS · `1` any DIFF / ERROR / SKIPPED · `2` the harness itself
failed · `3` the shared `.git/config` `core.bare` changed (never expected).
Reports: `scripts/buy-flow-parity/out/<stamp>_<base>_vs_<head>/report.md`, plus
`base.json`, `head.json`, `result.json` and each ref's build, migrate and API logs
(`out/` is gitignored).

## When it is required

Run it for **any PR that touches cart, order, payment, checkout, coupon,
promotion, shipping, tax, stock/inventory, bundle, refund/return or webhook code**,
or the Prisma schema/migrations under those tables. Paste the verdict table into
the PR. A DIFF is not automatically wrong. It means the PR changes buyer-visible
behaviour, and the owner has to approve that change explicitly (see `--allow`).

## What a run does

For each ref: `git worktree add --detach` into `$TMPDIR/fwb-buy-flow-parity/`
(child git runs with every `GIT_*` variable stripped; `core.bare` is checked before
and after), `npm ci` via npm@10 with `HUSKY=0`, `prisma generate`, then a build
of `packages/database`, `packages/shared` and `apps/api`. `prisma migrate deploy`
runs on a **fresh local database per ref**. The fixture is seeded as plain SQL (so
it is identical for both refs), and the built API starts **as the `force_app` RLS
role**, the same way production and CI run it. The scenarios then run over HTTP.

- **Postgres 16 + Redis 7** run as Apple `container`s `fwb-buyflow-pg`
  (127.0.0.1:55432) and `fwb-buyflow-redis` (127.0.0.1:56379). They are started if
  missing and reused otherwise. To use existing servers instead, pass
  `--pg-url`/`--redis-url`. Both must be loopback addresses, and the harness
  refuses anything else.
- **The API gets a hand-built environment.** Only PATH/HOME are inherited, and
  `.env` files are never copied into the temp worktree, so a shell that holds a
  production `DATABASE_URL` cannot reach the process under test.
- **Network boundary** (`lib/preload.mjs`, loaded with `node --import`, identical
  for both refs):
  - MyFatoorah (`api.`/`apitest.myfatoorah.com`) is rewritten to the local stub
    (`lib/stub.mjs`). The stub answers InitiatePayment, SendPayment,
    GetPaymentStatus, MakeRefund and GetRefundStatus, and records every request.
    The snapshot therefore contains the exact amount, currency, customer fields,
    callback URLs and bearer key the API sent.
  - **Every other non-loopback call is refused** (fetch and http/https). No real
    gateway, email, push or analytics call can happen.
- **Webhooks** are sent to the real `/webhooks/payment/myfatoorah` route and
  HMAC-signed with the per-store webhook secret seeded into `payment_configs`,
  which is exactly what `PaymentService.handleWebhook` verifies.
- **Inngest runs for real** (`lib/inngest-executor.mjs`). Events go to the stub.
  The executor then drives the API's own `/api/v1/inngest` endpoint with the SDK
  step protocol, right after the request that emitted each event, in a fixed
  order. This is what makes cancel → restock / coupon reversal (`order/refunded`),
  webhook processing (`payment/webhook.received`) and `order/created` part of the
  comparison. It differs from real Inngest in four ways: no retries (one attempt,
  errors memoised), no concurrency/throttle/idempotency windows, crons never run,
  and no `inngest/function.failed` fan-out. These differences apply to both refs,
  so they cannot create or hide a difference between them.
- Rate limiters are skipped through the API's own `LOAD_TEST_BYPASS_TOKEN`
  header. If any request is still throttled (429), the scenario is marked
  **ERROR**, so it can never report PASS.

## What is compared

Per scenario, after normalisation:

| part                                               | contents                                                                                                                |
| -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `http`                                             | every request the storefront, success page, gateway and admin made: status + full JSON body, keyed `NN_step`            |
| `db.orders`                                        | the whole `orders` row (`to_jsonb`), including subtotal/tax/shipping/discount/total/walletAmount, status, paymentStatus |
| `db.orderItems`, `db.payments`, `db.paymentEvents` | whole rows: provider, method, status, amount, metadata                                                                  |
| `db.orderEvents` / `orderEventStatuses`            | the `from→to` sequence plus markers (`coupon_reversed`, `refund_notified`)                                              |
| `db.inventory`, `db.inventoryHistory`              | product + variant stock after the scenario and each history row                                                         |
| `db.coupons`                                       | `usage_count` of every coupon the scenario owns                                                                         |
| `db.webhookEvents`                                 | inbox rows for the scenario's invoices                                                                                  |
| `gateway.myfatoorah`                               | every request the gateway stub received                                                                                 |
| `gateway.inngestEvents`, `inngestRuns`             | events emitted (name + data), and each background function run's outcome and step sequence                              |

Normalisation replaces only values that are random by construction: generated
UUIDs (`<id:N>` by first appearance, while seeded ids read `<seed:…>`), order
numbers, timestamps, JWT/CSRF tokens and the temp-worktree path. For a dev-mode
5xx body, only the last line of `error.message` is kept, with digits masked, so
the _reason_ still compares. One owner-specified default applies: `walletAmount`
(added by b1b5bbd1, default 0) counts as `0` where a ref lacks it, both in the
order row and in order-shaped API responses. **No money field, status, amount or
key is ever normalised.** Added and removed fields are diffs.

Each scenario owns its products and coupons, so a difference in one scenario
cannot cascade into another's stock or usage counts.

## Scenarios

`node scripts/buy-flow-parity/run.mjs --list`. They cover guest and signed-in
customers; a single item, multi-qty, a variant product and a bundle;
percentage/fixed coupons; per-area shipping and the free-shipping threshold; a
VAT 5% store; COD with fee (and a replayed payments/create); MyFatoorah create →
verify-on-return Paid, create → signed webhook Paid (+ duplicate replay), a forged
webhook signature, and create → gateway rejection → rollback; a failed payment;
out-of-stock (cart and order level); price/total tampering; an undeliverable
area; admin refund via provider; paid → cancel → refund; and COD cancel → restock

- coupon reversal.

A scenario that cannot be driven must call `ctx.skip(reason)`. It is then
reported as **SKIPPED** and fails the run. It is never counted as PASS.

## Accepting an intended change

```bash
node scripts/buy-flow-parity/run.mjs --head pr-1234 \
  --allow "paid-cancel-then-refund:db.orders=owner approved: cancelled paid orders are refundable (#1897)"
```

`--allow <scenario|*>:<path-prefix>=<reason>`. The reason is mandatory and is
printed next to every diff it waves through. A scenario whose diffs are all
allowed reports `PASS (allowed diffs)`.

## Options

`--keep-worktrees` keeps the built temp worktrees, so a rerun of the same sha
skips install and build (about 40s per ref). `--keep-db` keeps the per-ref
databases for inspection. `--api-port` (4610) and `--stub-port` (4690) change
the ports, and `--out <dir>` changes where reports go.
