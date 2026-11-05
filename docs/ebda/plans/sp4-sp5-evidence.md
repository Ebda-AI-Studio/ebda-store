# SP4 + SP5 closing evidence (2026-10-04)

Code under test: branch `claude/sp4-sp5-evidence`, base commit `32fa8556` (merge: sp4 worker stage 2). The only code-side change in
this branch is test infrastructure (`apps/api/vitest.workers.config.mts` reads `EBDA_WORKERS_TEST_DB_URL`, so a run on a shared host can
use its own pooler); no product code changed and no run exposed a bug. The commit that carries this file adds the scripts below.

Versions: Node 22.22.0, wrangler 4.116.0 (miniflare 4.20260730.0, workerd 1.20260730.1), Postgres 16.14, pgbouncer 1.22.0
(transaction mode, pool 8), Redis 7.0.15, Linux. Every API process ran as the strict-RLS role **`ebda_app`** (LOGIN, NOBYPASSRLS; startup
check on both runtimes logs `current_user=ebda_app rolbypassrls=false`). Databases are fresh `ev_*` (own migrate deploy of all 152
migrations), the Redis is its own (`:56411`), the pooler its own (`:6491`), ports 4811-4819.

A note on the shared dev-stack gotcha: `apps/api/dist` must be rebuilt after a pull (`rm -rf apps/api/dist && npm run build -w apps/api`).
A stale `dist` still held the removed Egypt providers, and the first parity run showed it (`knet` in `/payments/config` on the base side).
That run is discarded; the numbers below are from a clean rebuild.

## 1. Parity, Node (base) vs workerd (head), both as `ebda_app`

`bash scripts/ebda-parity-as-app.sh` (REMOVED in NZ-17 slice 2, Ruling NZ-17-SCRIPTS-1: it needed a Postgres/Hyperdrive head; kept here as evidence history) (base = `node apps/api/dist/index.js` on :4811 -> `ev_base` direct; head = `wrangler dev` of
`apps/api` on :4812 -> `ev_head` through pgbouncer :6491 via the Hyperdrive local connection string; harness stub :4813; Paymob stub via
`PAYMOB_BASE_URL` + `PAYMENT_PROVIDER_STUB=1`; the four `PAYMENT_*` card-testing budgets raised; Worker started with a fresh `--persist-to`).
The harness truncates and seeds each side as the owner (`parity`) and the APIs never see the owner role.

Verdict (`out/2026-10-04T03-27-17-596Z_url-base_vs_url-head/result.json`, read per `rows[].verdict`): **16/16 PASS, 0 DIFF, 0 ERROR, exit 0**,
payment-endpoint guard active (it ERRORs any 404 on `/payments*` or `/webhooks/payment*`). Real payment traffic on BOTH sides, identical:
`create-payment` 200 x14 (+1 deliberate gateway refusal 502), `create-payment-replay` 200, `verify-payment` 200 x9, signed webhook paid /
duplicate / forged / failed all 200, `refund-via-provider` 200 x2, `payments-config` 200 x17. Harness time per side: Node 26 s, Worker 30 s.
This closes the "As ebda_app ... still not covered" item of `stage2-parity.md` (the SP6a RLS fix for the payment routes holds on both runtimes).

## 2. SP4 done-when: Amelia Aurum on the Worker

Seeded into `ev_sp` (the Worker's database) as `ebda_app`: `DATABASE_URL=postgresql://ebda_app:...@127.0.0.1:5432/ev_sp npx tsx scripts/ebda-seed-amelia.mjs`
-> `total 33, created 13, variantsCreated 20, failed 0` (synthetic fixture `tests/fixtures/amelia-aurum-catalogue.csv`, not Amelia's real export).
Then `node scripts/ebda-amelia-http-check.mjs --api http://127.0.0.1:4816/api/v1` against `wrangler dev`, exit 0:

| request (host header `x-store-domain`)                         | result                                                                                          |
| -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `GET /public/products?limit=50`, `amelia.ebda.app`             | 200, 12 products (13 imported, the draft is correctly not public), 650.00 .. 38,900.00 EGP      |
| `GET /public/stores/amelia`, `amelia.ebda.app`                 | 200, `currency EGP`, `timezone Africa/Cairo`                                                    |
| `GET /public/products/solitaire-ring-18k`, `amelia.ebda.app`   | 200, 1875000 piastres = 18,750.00 EGP, 4 variants 1875000/1885000/1895000/1905000               |
| `GET /public/products?limit=50`, `rival.ebda.app`              | 400 `STORE_NOT_RESOLVED`, no data (host has no store: refused, never another store's catalogue) |
| `GET /public/products/solitaire-ring-18k`, `rival.ebda.app`    | 400 `STORE_NOT_RESOLVED`                                                                        |
| `GET /public/products?limit=50`, unknown host / no host header | 400 `STORE_NOT_RESOLVED`, no data                                                               |

Tenant isolation with a REAL second store in the same database: the store the E2E below created (`e2e-3c84abb2.ebda.app`) lists only its own
product, and `GET /public/products/solitaire-ring-18k` on its host answers 404 `Product not found`. No-Ebda Store-branding test:
`npx vitest run tests/unit/no-ebda-branding.test.ts` -> 4/4 green (also inside the full unit run, section 5).
Note: an unknown host answers 400 `STORE_NOT_RESOLVED`, not 404 (design: the resolver throws on an unknown host; the plan's "404/empty" is
met in substance: nothing is served).

## 3. SP5 unaided E2E (HTTP only)

`scripts/ebda-e2e-self-serve.mjs --api <url>/api/v1 --mail-log <server stdout>`; servers started with `scripts/ebda-dev-api.sh`
(`MODE=node` on :4815 -> `ev_spn`; `MODE=worker` on :4816 -> `ev_sp`, both `ebda_app`, Inngest events to a local accept-all listener,
`SIGNUP_IP_PER_HOUR` raised only so repeat runs from one IP are not throttled). Steps: signup (form token, minimum fill time, signup) ->
read verification token -> verify -> login -> create store (slug) -> template -> first product 19900 piastres (EGP 199.00) -> enable COD ->
go live -> storefront lists the product at `<slug>.ebda.app` -> customer adds 2 to cart -> reads cart / payment config / shipping quote ->
checkout COD (`POST /public/orders`, `POST /payments/create` provider cod) -> merchant lists orders and finds it -> setup guide shows
`add_product, payment, test_order` done. **PASS on both runtimes, twice each.**

How the verification token is read: the API deliberately exposes no outbox over HTTP (`platform-mailer.ts`: "never exposed over HTTP"). Outside
production it logs the link (`[PLATFORM-MAIL] captured`), so the script reads the server's own stdout log from the byte offset the run started
at (pino-pretty on Node, JSON lines on the Worker). That is the one non-HTTP input, same as `tests/integration/self-serve-onboarding-live.test.ts`.

Wall time per step, ms (the 3200 ms is the anti-bot minimum form-fill wait `SIGNUP_MIN_FILL_MS`, deliberate, a human is never faster):

| step                                          | Node #1  | Worker #1 | Node #2  | Worker #2 |
| --------------------------------------------- | -------- | --------- | -------- | --------- |
| health                                        | 59       | 58        | 52       | 62        |
| signup: get form token                        | 9        | 17        | 6        | 14        |
| (anti-bot minimum form-fill wait)             | 3200     | 3200      | 3200     | 3200      |
| signup                                        | 388      | 411       | 323      | 357       |
| read verification token (server log)          | 1        | 0         | 0        | 1         |
| verify email                                  | 22       | 50        | 17       | 29        |
| login                                         | 335      | 350       | 317      | 352       |
| create store (slug)                           | 369      | 415       | 348      | 374       |
| choose template                               | 40       | 49        | 30       | 42        |
| first product                                 | 48       | 55        | 33       | 44        |
| enable cash on delivery                       | 42       | 75        | 27       | 68        |
| go live                                       | 31       | 60        | 26       | 47        |
| storefront: product visible at the store host | 34       | 43        | 14       | 31        |
| customer: add to cart                         | 71       | 88        | 50       | 71        |
| customer: cart + COD config + shipping quote  | 34       | 67        | 31       | 58        |
| customer: checkout (COD) -> order created     | 143      | 183       | 105      | 145       |
| merchant sees the order                       | 18       | 28        | 27       | 26        |
| merchant setup guide                          | 17       | 26        | 28       | 23        |
| **total wall**                                | **4862** | **5180**  | **4635** | **4950**  |
| total minus the deliberate wait               | 1662     | 1980      | 1435     | 1750      |

Scripted, the whole funnel from signup to a merchant seeing a COD order is about 5 s on either runtime, about 1.4-2.0 s of it API time. The
Worker is 15-20% slower per step on a local single-thread workerd; real-edge latency is not measured (needs the Cloudflare token).
Login (~330 ms) and signup (~350 ms) are bcrypt, the same on both runtimes.

## 4. Stage 2 workerd tests and pooler isolation (sanity, this HEAD)

- `EBDA_WORKERS_TEST_DB_URL=postgresql://ebda_app:...@127.0.0.1:6491/ev_head npm run cf:test -w apps/api` (after loading
  `apps/api/scripts/cf-seed.sql` into that database as the owner, which `entry.test.ts` needs): **4 files, 29/29 passed**. Without the seed
  4 DB tests fail on missing alpha/bravo rows (seed precondition, not a defect).
- `DATABASE_URL=<owner url of ev_t> REQUIRE_PGBOUNCER=1 npx vitest run tests/integration/rls-pooler-isolation.test.ts`: **11 passed**
  (the 1 skipped is the "binary is installed" guard, which only exists when pgbouncer is absent).

## 5. Gates

`npm run typecheck` exit 0. `npm run test:unit` exit 0: 486 files, 6562 passed, 1 skipped, 0 failed.

## 6. What still needs Ahmad: the timed manual run (< 10 min target)

A human timed run cannot be simulated here. The scripted figure above (about 5 s) is the floor, not the target: STATUS.md's "timed manual run
under 10 minutes" stays OPEN until someone does the clicks below on a real stack (staging, or local `npm run dev` for api + admin + web with
the API's log open for the verification link, since local mail is only logged).

Clicks, in order, start the stopwatch at the first one (admin app origin `https://admin.ebda.app`, locally `http://localhost:3001`):

1. `/signup` (title "Create your store"): name, email, phone, password -> "Create my account".
2. Open the verification mail link (`/verify-email?token=...`; locally copy it from the API log line `[PLATFORM-MAIL] captured`). It redirects to `/login?returnTo=%2Fonboarding` -> sign in.
3. `/onboarding` step 1 "Name": store name, store address (slug, wait for "... is available") -> "Create my store".
4. Step 2 "Look": pick a template -> "Continue".
5. Step 3 "Product": name, price (EGP), quantity in stock (photo optional) -> "Add product" -> "Continue".
6. Step 4 "Payment": leave "Cash on delivery" on -> "Continue".
7. Step 5 "Launch": "Publish my store" -> "Open my store" (`https://<slug>.ebda.app`).
8. Storefront: open the product -> add to cart -> checkout, Cairo / Nasr City address, pay with cash on delivery -> place order.
9. Back in the admin: "Go to dashboard" (`/stores/<id>`) -> Orders (`/stores/<id>/orders`): the order is listed. Stop the stopwatch.

Record the time and the date under SP5 in `docs/ebda/plans/STATUS.md`.

## Reproduce

```bash
# owner_url_for <db> = the owner (superuser "parity", local password) URL of a database on 127.0.0.1:5432; EBDA_APP_URL_EV_SP = the same database as role ebda_app (password ci-only-app-pw, see apps/api/pgbouncer/userlist.txt)
export PGPASSWORD=...   # the owner role password, for psql
for db in ev_base ev_head ev_sp ev_spn ev_t; do
  psql -h 127.0.0.1 -U parity -d postgres -c "create database $db owner parity"
  U=$(owner_url_for $db); DATABASE_URL=$U DIRECT_URL=$U npx prisma migrate deploy --schema=packages/database/prisma/schema.prisma
done
redis-server --port 56411 --daemonize yes --dir /tmp
# pgbouncer 1.22, transaction mode, pool 8, :6491, [databases] ev_head and ev_sp, auth file = apps/api/pgbouncer/userlist.txt (ebda_app / ci-only-app-pw)
rm -rf apps/api/dist && npm run build -w apps/api
bash scripts/ebda-parity-as-app.sh                                   # section 1
# (MODE=worker was removed from ebda-dev-api.sh in NZ-17 slice 2; the Worker needs no Postgres)
MODE=node   PORT=4815 DB=ev_spn INNGEST_PORT=4817 LOG=/tmp/ev-node-sp.log bash scripts/ebda-dev-api.sh &
DATABASE_URL=$EBDA_APP_URL_EV_SP npx tsx scripts/ebda-seed-amelia.mjs   # section 2
node scripts/ebda-amelia-http-check.mjs --api http://127.0.0.1:4816/api/v1
node scripts/ebda-e2e-self-serve.mjs --api http://127.0.0.1:4816/api/v1 --mail-log /tmp/ev-worker-sp.log    # section 3
node scripts/ebda-e2e-self-serve.mjs --api http://127.0.0.1:4815/api/v1 --mail-log /tmp/ev-node-sp.log
```
