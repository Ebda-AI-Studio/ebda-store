# SP4 Stage 2: buy-flow parity, Node against Workers (2026-10-04)

Branch `claude/sp4-worker-stage2`. Harness: `scripts/buy-flow-parity/run.mjs` in api-url mode
(`--api-url-base` / `--api-url-head`, see its README). Design: `cloudflare-backend.md` section 8, item 3.

## Verdict

**16/16 PASS**, Node (Express) as base, the same code on `wrangler dev` (workerd) as head, each side its own
freshly migrated database (`bfp_a`, `bfp_b`), the MyFatoorah stub of the harness behind `MYFATOORAH_BASE_URL` +
`PAYMENT_PROVIDER_STUB=1`, Inngest functions executed by the harness against each side's own `/api/v1/inngest`.
`result.json`, every `rows[].verdict`:

| scenario                             | verdict |
| ------------------------------------ | ------- |
| guest-mf-single-verify-paid          | PASS    |
| guest-mf-multiqty-webhook-paid       | PASS    |
| webhook-forged-signature             | PASS    |
| customer-mf-variant-pct-coupon       | PASS    |
| guest-cod-fee-fixed-coupon           | PASS    |
| customer-cod-free-shipping-threshold | PASS    |
| vat-store-mf-pct-coupon              | PASS    |
| mf-create-fails-rollback             | PASS    |
| mf-payment-failed                    | PASS    |
| out-of-stock                         | PASS    |
| price-tampering                      | PASS    |
| bundle-checkout-mf                   | PASS    |
| area-not-deliverable                 | PASS    |
| paid-refund-via-provider             | PASS    |
| paid-cancel-then-refund              | PASS    |
| cod-cancel-restock                   | PASS    |

Two things about this verdict are not the headline and are stated plainly:

1. **Both sides ran as a role that bypasses RLS** (the database owner `parity`, a superuser). As `ebda_app`
   (strict RLS, what production runs as) `POST /payments/create` answers `404 Order not found` for every
   order on BOTH runtimes: the route (`payment.routes.ts`, mounted without `tenantContext`) reads
   `prisma.order.findFirst` with no store set, and strict RLS shows a contextless caller no orders
   (`select count(*) from orders` as `ebda_app` returns 0 with 15 rows present). That is a defect of this branch,
   not a runtime difference: it is identical on Node, so the harness shows 10 scenarios as `ERROR` ("stub: no invoice")
   and the 6 that never reach a provider as `PASS` (vacuously: both sides answer the same 404). It belongs to the
   payments work (SP6a) and was not touched here. Until it is fixed the parity run needs the owner role on both sides.
   The Worker's startup role check logs `rolbypassrls=true` as `[SECURITY FATAL]` in that configuration; that is the
   guard working, not a failure.
2. The Worker exit test (`apps/api/scripts/stage1-exit-test.mjs`) covers concurrency and tenant isolation under strict
   RLS on workerd; this run covers behaviour. They are complementary, not substitutes.

## What the first runs found (real runtime differences, all fixed)

The first complete run on the Worker was **12 PASS, 4 DIFF/ERROR** and an earlier one 12/16 with a login that hung.
Every one of these was a genuine difference between Node and workerd, not noise:

| symptom on the Worker                                                                                                                             | root cause                                                                                                                                                                                                                                                                                                                                                                                                                                 | fix                                                                                                                                                                                                                                                                                                                                             |
| ------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /auth/login` for a user that exists hung until the runtime cancelled it ("your Worker's code had hung"); a wrong password answered normally | A Prisma request on a pooled client never dispatched. `register` started `sendVerificationEmail` as a floating promise; on a Worker it runs after the response, its `prisma.store.findUnique` batched into the client's request DataLoader, and the dispatch microtask was lost with the dead request context, leaving `tickActive = true` forever. The next request that leased that client hung on its first query inside a transaction. | The lease is refused to code that outlives its request (`prisma` throws "database used after its request ended"), a client with a lost dispatch is discarded on release, and floating work now goes through `cfWaitUntil` and is awaited before the lease is released (`register`, `deferAfterTenantCommit` inline path, payment-confirm push). |
| `mf-create-fails-rollback`, `cod-cancel-restock`, `paid-refund-via-provider`: stock not restored, coupon not reversed, order not cancelled        | The API opens a SECOND transaction while the request's tenant transaction is open (`withMoneyTx` inside `runInTenantContext`; `tests/unit/nested-transaction-registry.test.ts` lists them). A request had ONE pg connection on Workers, so the second waited for pg's 10 s connect timeout ("timeout exceeded when trying to connect"): the Inngest fan-out step and the payment-failure rollback failed.                                  | A request may hold 3 connections (`connectionsPerRequest`); they are sockets to the pooler, which assigns a server connection only while a transaction is open. Regression tests on Node (with a one-connection negative control) and on workerd (mutation-checked).                                                                            |
| `paid-cancel-then-refund` / the later payment scenarios: `429 PAYMENT_RATE_LIMITED`                                                               | Not a runtime difference. The card-testing guard (SP5) limits 10 payment attempts per IP per 10 minutes and ignores the harness's load-test token; a run makes 12+ from 127.0.0.1. It hit Node first (Redis flushed per run) and the Worker on repeat runs (Durable Object state is not).                                                                                                                                                  | Harness: raise the four `PAYMENT_*` budgets on both sides, start the Worker with a fresh `--persist-to` dir per run. Documented in the harness README.                                                                                                                                                                                          |

Negative control: the 12 PASS / 4 DIFF run IS the control. The harness reported the Worker's missing rollback
(`db.orders[0].status` base `cancelled`, head `pending`; `db.inventory.products[0].inventory` 5 against 1;
`inngestRuns.order/refunded ... .status` `completed` against `failed`) and the hung login
(`http.01_auth.login.status` 200 against 500) as DIFF before the fixes, and went to 16/16 after them, with the code
otherwise unchanged. Setting `connectionsPerRequest` back to 1 turns the workerd nested-transaction test red.

## How to run it

```bash
PARITY_PW=parity   # the local password of the harness role, for the URLs below
su postgres -c "psql -c \"CREATE ROLE parity SUPERUSER LOGIN PASSWORD '$PARITY_PW'\""   # once
redis-server --daemonize yes --port 56390                   # base side only; the Worker keeps state in a Durable Object
for db in bfp_a bfp_b; do
  su postgres -c "psql -c 'drop database if exists $db' -c 'create database $db owner parity'"
  DATABASE_URL=postgresql://parity:${PARITY_PW}@127.0.0.1:5432/$db npx prisma migrate deploy --schema=packages/database/prisma/schema.prisma
done
npm run build -w apps/api
STUB=http://127.0.0.1:4790
COMMON="JWT_SECRET=bfp-parity-jwt-secret-local-only-0123456789 ENCRYPTION_KEY=bfp-parity-encryption-key-local-only-0123456789 \
  INNGEST_BASE_URL=$STUB INNGEST_DEV=$STUB BFP_STUB_URL=$STUB LOAD_TEST_BYPASS_TOKEN=bfp-parity-load-test-token \
  MYFATOORAH_BASE_URL=$STUB/mf PAYMENT_PROVIDER_STUB=1 PAYMENT_ATTEMPTS_PER_IP_10M=100000 PAYMENT_ATTEMPTS_PER_STORE_10M=100000 \
  PAYMENT_SESSION_MAX_DECLINES=1000 PAYMENT_IP_MAX_DECLINES=100000 NODE_ENV=development"
# base: Node
env $COMMON PORT=4711 API_URL=http://127.0.0.1:4711 WEB_URL=http://localhost:3000 ADMIN_URL=http://localhost:3001 \
  DATABASE_URL=postgresql://parity:${PARITY_PW}@127.0.0.1:5432/bfp_a DIRECT_URL=postgresql://parity:${PARITY_PW}@127.0.0.1:5432/bfp_a \
  REDIS_URL=redis://127.0.0.1:56390 node apps/api/dist/index.js &
# head: workerd (fresh persist dir every run: the rate-limit counters live in the AuthState Durable Object)
(cd apps/api && WRANGLER_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE=postgresql://parity:${PARITY_PW}@127.0.0.1:5432/bfp_b \
  npx wrangler dev --port 4712 --local --persist-to "$(mktemp -d)" \
  $(for kv in $COMMON API_URL=http://127.0.0.1:4712 WEB_URL=http://localhost:3000 ADMIN_URL=http://localhost:3001; do echo --var ${kv/=/:}; done)) &
P=postgresql://parity:${PARITY_PW}@127.0.0.1:5432
node scripts/buy-flow-parity/run.mjs --api-url-base http://127.0.0.1:4711 --api-url-head http://127.0.0.1:4712 \
  --pg-url-base $P/bfp_a --pg-url-head $P/bfp_b --redis-url-base redis://127.0.0.1:56390 --stub-port 4790
```

Read `scripts/buy-flow-parity/out/<stamp>/result.json` (`rows[].verdict`), not the exit code alone. The ports are
chosen away from 4610 / 4611 / 4690, which other worktrees' harness runs use on the same host (a run of this branch
once reached another worktree's API on 4611 and flushed another run's Redis on 56379 before this was noticed; neither
side held anything but fixture data).

## What is still not covered

- Strict RLS for the payment routes (item 1 above). Re-run with `ebda_app` on both sides once SP6a fixes them.
- The harness drives Inngest steps through the Worker's `/api/v1/inngest` endpoint; a real Inngest cloud delivering to a
  deployed Worker was not run (needs credentials).
- `res.on('close')` rollback on a client abort, the MCP transport and `bulk/export.xlsx` streaming were not exercised by
  these 16 scenarios.
