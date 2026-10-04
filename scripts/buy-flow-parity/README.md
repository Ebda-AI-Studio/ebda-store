# Buy-flow parity harness

Answers one question with evidence: **does this change alter what happens when a
customer buys?** It runs the same deterministic buy scenarios against two git refs
and diffs the outcome field by field. Identical output means the change does not
influence ordering or payment. Any difference is printed as a field path with the
base and head values.

There is no default baseline (the old FWB Kuwait commit `96814545` is irrelevant for
Ebda): in ref mode `--base <ref>` is required (use `origin/main` for "current
main"); `--head` defaults to `HEAD`. See the **Ebda** section below for Linux usage
and the runtime (api-url) mode.

```bash
npm ci                                                  # once, for this checkout
node scripts/buy-flow-parity/run.mjs --base origin/main --head <ref>
node scripts/buy-flow-parity/run.mjs --base <ref> --head <ref>
node scripts/buy-flow-parity/run.mjs --list             # scenario ids
node scripts/buy-flow-parity/run.mjs --base origin/main --head pr-1234 --only guest-cod-fee-fixed-coupon,cod-cancel-restock
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
it is identical for both refs), and the built API starts **as the `ebda_app` RLS (override: `PARITY_APP_ROLE`)
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
  - Paymob (`accept.paymob.com`) is rewritten to the local stub
    (`lib/stub.mjs`). The stub answers the Intention API, transaction inquiry,
    refund and void, and records every request.
    The snapshot therefore contains the exact amount, currency, customer fields,
    callback URLs and `Token` key the API sent.
  - **Every other non-loopback call is refused** (fetch and http/https). No real
    gateway, email, push or analytics call can happen.
- **Webhooks** are sent to the real `/webhooks/payment/paymob` route (HMAC-SHA512 over
  the transaction fields, in `?hmac=`) signed with the per-store HMAC secret seeded into `payment_configs`,
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
| `gateway.paymob`                                   | every request the gateway stub received                                                                                 |
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
VAT 5% store; COD with fee (and a replayed payments/create); Paymob create →
verify-on-return Paid, create → signed webhook Paid (+ duplicate replay), a forged
webhook signature, and create → gateway rejection → rollback; a failed payment;
out-of-stock (cart and order level); price/total tampering; an undeliverable
area; admin refund via provider; paid → cancel → refund; and COD cancel → restock

- coupon reversal.

A scenario that cannot be driven must call `ctx.skip(reason)`. It is then
reported as **SKIPPED** and fails the run. It is never counted as PASS.

## Accepting an intended change

```bash
node scripts/buy-flow-parity/run.mjs --base origin/main --head pr-1234 \
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

## Ebda

Ebda is EGP (piastres), so the fixture is too: stores are `currency 'EGP'`, prices,
the COD fee (500 = 5.00 EGP), delivery rates (Cairo / Nasr City 1500, free over
40000; Giza / Dokki 2000), coupons and the VAT store (14%) are all integer
piastres, addresses are Egyptian (`country: 'Egypt'`, `+20` mobile) and the stub
speaks EGP. Scenario ids are unchanged.

### Linux (no Apple `container`)

Pass your own loopback Postgres 16 and Redis; the harness then never touches
`container`. The Postgres role needs `CREATEDB` (superuser is simplest):

```bash
PARITY_PW=parity   # local password of the harness role, used as ${PARITY_PW} in the URLs below
su postgres -c "psql -c \"CREATE ROLE parity SUPERUSER LOGIN PASSWORD '$PARITY_PW'\""
redis-server --daemonize yes --port 56379
node scripts/buy-flow-parity/run.mjs --base origin/main --head HEAD \
  --pg-url postgresql://parity:${PARITY_PW}@127.0.0.1:5432/postgres --redis-url redis://127.0.0.1:56379
```

### api-url mode: same code on two runtimes

`--api-url-base <url>` / `--api-url-head <url>` (either or both) skip worktree,
build and spawn for that side: the scenarios run over HTTP against an API that is
already running (Node-Express, a Cloudflare Worker, ...). Sides may be mixed (one
ref, one URL).

**DB seeding per side.** An external API is already connected to its database, so
the harness cannot drop and recreate it. Each side therefore gets its own
`--pg-url-base` / `--pg-url-head` (owner/superuser URL of the database that side's
API uses, **already migrated**; `--pg-url` is the fallback for both, in which case
one database is simply re-seeded between the two sequential sides). Before a side
runs, every public table except `_prisma_migrations` is `TRUNCATE ... CASCADE`d and
the plain-SQL fixture is seeded, so a side can be re-run any number of times.
Redis is `FLUSHALL`ed per side when `--redis-url-base/-head` (or `--redis-url`) is
given. All URLs must be loopback.

The API under test must be started by you with the harness environment (the
harness cannot inject it):

| env var                                               | value                                                                                 |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `DATABASE_URL`                                        | the side's DB as the `ebda_app` RLS (override: `PARITY_APP_ROLE`) role (like prod/CI) |
| `ENCRYPTION_KEY`                                      | harness key (default in `run.mjs`; or `--encryption-key`)                             |
| `LOAD_TEST_BYPASS_TOKEN`                              | `bfp-parity-load-test-token`                                                          |
| `INNGEST_BASE_URL` and `INNGEST_DEV`                  | `http://127.0.0.1:4690` (the harness stub)                                            |
| `PAYMOB_BASE_URL`                                     | `http://127.0.0.1:4690/paymob`                                                        |
| `NODE_ENV=development` (or `PAYMENT_PROVIDER_STUB=1`) | required for the override to be honoured                                              |

`PAYMOB_BASE_URL` (documented in `docs/ENVIRONMENT.md`) is the runtime-agnostic
replacement for the `node --import` preload: the provider calls the stub directly,
so it works on a Worker. The harness runs the stub (`lib/stub.mjs`) as a loopback
HTTP server in its own process (`--stub-port`, 4690) and records the same requests
in both modes. The preload is kept for ref mode (old refs have no override), so
both modes record identical gateway requests. Unlike the preload, api-url mode does
NOT block other outbound calls: the API under test must be configured so that no
real email/push/analytics credential exists.

```bash
P=postgresql://parity:${PARITY_PW}@127.0.0.1:5432
node scripts/buy-flow-parity/run.mjs \
  --api-url-base http://127.0.0.1:4611 --api-url-head http://127.0.0.1:4612 \
  --pg-url-base $P/bfp_a --pg-url-head $P/bfp_b --redis-url redis://127.0.0.1:56379
```

Always read `out/<stamp>/result.json` (`rows[].verdict`), not just the exit code.

### Payment endpoints must be real (guard)

Two sides that are equally broken diff clean: the 2026-10-03 run reported 16/16 PASS
while every `/payments/create` answered 404 on both sides. `lib/guards.mjs`
(`paymentEndpointProblems`) therefore fails a scenario that is otherwise a PASS when
any step on `/payments*` or `/webhooks/payment*` answered 404, or when an expectation
declared with `ctx.expect(step, [codes])` is unmet (step never ran, or another
status). The verdict is then ERROR with the reason, and the guard has a unit test
(`tests/unit/buy-flow-parity-guards.test.ts`).

**Card-testing guard.** `payments/create` is limited per IP (10 / 10 min) and per store
by `card-testing-guard.service.ts`, and the load-test token does not skip it. One run
makes 12+ payment attempts from 127.0.0.1, so raise the budgets on BOTH sides:
`PAYMENT_ATTEMPTS_PER_IP_10M=100000 PAYMENT_ATTEMPTS_PER_STORE_10M=100000
PAYMENT_SESSION_MAX_DECLINES=1000 PAYMENT_IP_MAX_DECLINES=100000`. The counters of a
Worker live in its AuthState Durable Object, which the harness cannot reset: start
`wrangler dev` fresh (and with `--persist-to <empty dir>`) for every run.

### A Cloudflare Worker as one side

Head = `wrangler dev` of `apps/api` (workerd), base = the same code on Node. Each side
has its own database; the Worker reaches its database through the Hyperdrive binding, so
point that at the head database with
`WRANGLER_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE=postgresql://...` (a pgbouncer in
transaction mode, or the database directly). The harness variables of the table above are
passed as `wrangler dev --var NAME:value` (`NODE_ENV`, `API_URL`, `JWT_SECRET`,
`ENCRYPTION_KEY`, `INNGEST_BASE_URL`, `INNGEST_DEV`, `BFP_STUB_URL`, `LOAD_TEST_BYPASS_TOKEN`,
the payment-stub base URL variable named above (Paymob since SP6b), `PAYMENT_PROVIDER_STUB`, the four `PAYMENT_*` budgets above). The full
procedure and the verdict are in `docs/ebda/design/stage2-parity.md`.

### Results (2026-10-04, Linux, Postgres 16 + Redis 7)

- Both sides = the Node-Express API built from the same commit, two instances
  (:4611 / :4612), two fresh databases (`sp6b_a` / `sp6b_b`), api-url mode:
  **16/16 PASS**, with real 200s on the payment endpoints (head: `create-payment` 200 x14
  (+1 deliberate gateway refusal -> 502), `create-payment-replay` 200, `verify-payment` 200 x9,
  signed webhook paid / duplicate / failed 200, admin refund-via-provider 200 x2).
- Negative control (guard): both instances run with the payments router mounted at a
  wrong path (built output only, reverted): every scenario **ERROR**, exit 1 ("payment
  endpoint answered 404 ..."), although the two sides were identical. After the revert
  the suite is 16/16 PASS again.
