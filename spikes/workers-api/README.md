# Spike: FWB per-request RLS transaction on Cloudflare Workers (workerd) + Prisma 6 + pgbouncer

**Question:** can FWB's "one interactive transaction per request, `set_config` the tenant GUCs first, commit before responding" model run on workerd with Prisma 6 + `@prisma/adapter-pg`, through a transaction-mode pooler (what Hyperdrive does), with no cross-tenant leak?

**Answer: yes, locally.** 17/17 tests pass on workerd, 0 leaks in 300 interleaved requests over a pool of 2 server connections, and a mutation check proves the isolation tests fail when the GUC handling is broken. What this does *not* prove is Cloudflare's real Hyperdrive pooler (see Gaps).

## Layout

```
wrangler.jsonc            nodejs_compat, Hyperdrive binding (localConnectionString -> pgbouncer :6432 as ebda_app)
src/host.ts               host -> slug|custom-domain (pure), reserved slugs
src/db.ts                 per-request Prisma+pg adapter, setTenantGucs, runRequest (the ONE transaction)
src/index.ts              Hono routes: GET /products, POST /cart/items, POST /webhooks/payments/:provider
prisma/schema.prisma      stores, products, carts, cart_items, webhook_events (money = Int piastres)
prisma/migrations/.../    tables, role ebda_app (NOBYPASSRLS), ENABLE+FORCE RLS, strict policies
prisma/seed.sql           stores `amelia` (+custom domain shop.amelia.example) and `rival`, distinct products
pgbouncer/pgbouncer.ini   pool_mode=transaction, default_pool_size=2, server_reset_query empty
scripts/                  db-setup.sh, pooler.sh, mutation-check.sh, smoke-dev.mjs
test/                     isolation.test.ts, routes.test.ts, timing.test.ts (run in workerd)
results/                  captured outputs of the runs quoted below
```

## How to run (as root in this sandbox; pgbouncer drops to the `postgres` user)

```bash
cd spikes/workers-api
npm install --legacy-peer-deps     # plain `npm i` of vitest-pool-workers crashes arborist ("edgesOut") here
npx prisma generate                # DATABASE_URL only needs to be set for `migrate`, not generate
bash scripts/db-setup.sh           # drops/creates ebda_spike, applies migration, sets FAKE dev password, seeds
bash scripts/pooler.sh start       # pgbouncer on 127.0.0.1:6432 (transaction mode, pool 2)
npx vitest run                     # all tests, on workerd (exit 0 expected)
bash scripts/mutation-check.sh     # baseline -> 2 mutations (expect RED) -> restore (expect green)
# second harness, real `wrangler dev` over HTTP:
npx wrangler dev --port 8799 & node scripts/smoke-dev.mjs
```

## Test harness choice

Tests run **on workerd via `@cloudflare/vitest-pool-workers`** (not a script against `wrangler dev`), because that keeps the real Worker, the real Hyperdrive binding and Prisma's wasm query compiler in one workerd isolate, so tests can both call the Worker (`exports.default.fetch`) and open raw transactions with the same client factory (needed for "GUC not set" and pooled-connection probes). It needed two config workarounds (below). A `wrangler dev` script (`scripts/smoke-dev.mjs`, spoofed Host header, 240 requests at concurrency 24) is a second independent harness on a newer workerd.

## Results

`npx vitest run` (exit 0): `Test Files 3 passed, Tests 17 passed` (`results/green-run.txt`).

| Required test | Result |
|---|---|
| 300 interleaved concurrent requests (alternating amelia/rival hosts, plus every 5th op a no-GUC probe transaction); every response only that host's products | PASS, leaks=0, non-200=0; 2 distinct backend PIDs, both PIDs served both tenants (reuse proven) |
| Request with GUC unset returns zero rows (reads), write rejected, `stores` not even granted | PASS |
| Role is `ebda_app`, not superuser, not BYPASSRLS; all 5 tables ENABLE+FORCE RLS | PASS |
| After an amelia tx, a reused pooled connection cannot see the GUC (40 pairs, same backend PID in 15-35 of 40) | PASS, leaks=0 |
| NEGATIVE CONTROL: session-level `set_config(...,false)` leaks through pgbouncer | PASS (it leaked 13/20 to 20/20 times, so the harness can fail) |
| Cart add twice -> quantity 2, both 200, no 25P02 | PASS |
| 12 concurrent adds to one cart -> quantity 12, all 200 (Prisma upsert+increment race) | PASS |
| Other tenant's product id on this host -> 404, nothing written; same session id on two hosts -> two carts | PASS |
| Webhook: bad/missing/non-hex/other-body signature -> 401; unknown provider -> 404; nothing stored | PASS |
| Webhook good -> 200 + cart paid; replay -> 200 `duplicate:true`, one row; 5 simultaneous replays -> one row, all 200 | PASS |
| Webhook delivered on rival's host cannot mark amelia's cart paid | PASS |
| Unknown host / apex / `a.b.ebda.app` / foreign domain / invalid labels -> 404; custom domain + case/port normalised -> amelia | PASS |
| Each of the 8 reserved slugs (`app api docs help status whatsapp www admin`) -> 404 | PASS |
| `wrangler dev` smoke: 240 requests @24 concurrency, leaks=0, unknown host 404, reserved host 404 | PASS (`results/smoke-dev.txt`) |

### Mutation check (`bash scripts/mutation-check.sh`, output in `results/mutation-check.txt`)

| Step | vitest exit | Outcome |
|---|---|---|
| baseline | 0 | 16/16 (isolation + routes) green |
| Mutation 1: `set_config(..., true)` -> `false` (session-level, both GUCs) | **1** | RED: 3 failed: the 300-request load test (no-GUC probes saw a previous tenant's GUC/rows), "GUC not set returns zero rows", "transaction-local ... does not leak". All route tests stayed green: each request overwrites the GUC before reading, so **only the unscoped probes can detect this mutation**. That is why the load test contains them. |
| Mutation 2: store-id `set_config` call deleted | **1** | RED: 8 failed (load test, reuse test, every cart/webhook test: strict RLS gives 0 rows / rejects inserts). "GUC not set" correctly stays green here. |
| restored (`diff` identical) | 0 | 16/16 green |

The pooler is restarted between runs because mutation 1 leaves session-level state on server connections.

### Versions

| | |
|---|---|
| Node | 22.22.0 |
| wrangler | 4.147.0 (`wrangler dev` workerd 1.20261001.1) |
| `@cloudflare/vitest-pool-workers` | 0.22.0 (miniflare 5.20260815.0-alpha, **workerd 1.20260815.1**, newest compat date 2026-08-22) |
| vitest | 4.1.11 |
| prisma / @prisma/client | 6.19.3 (`engineType = "client"`, query compiler + wasm, no native engine) |
| @prisma/adapter-pg | 6.19.3 |
| pg / pg-cloudflare / pg-pool | 8.23.1 / 1.4.1 / 3.14.0 |
| hono | 4.13.12 |
| PostgreSQL / pgbouncer | 16.14 / 1.22.0 |

### Timings (localhost, Miniflare Hyperdrive proxy -> pgbouncer -> pg; `results/timing.txt`)

Sequential, uncontended, 40 samples after warmup. Every request opens a fresh pg connection (SCRAM handshake via pgbouncer) and a new Prisma client. workerd timer resolution is ~1 ms.

| Route | end-to-end p50 / p95 | in-handler transaction (connect + BEGIN..COMMIT) p50 / p95 |
|---|---|---|
| first request in an isolate (wasm init + cold connect) | 757-869 ms | n/a |
| GET /products | 14 / 22 ms | 11 / 17 ms |
| POST /cart/items | 21 / 28 ms | 17 / 23 ms |
| POST /webhooks/payments/fakepay | 19 / 26 ms | 12 / 15 ms |

Under load (300 requests, concurrency 30, pool_size 2): p50 ~430-490 ms, p95 ~1.3-1.6 s, total ~5.5 s. That is queueing for 2 server connections, not slowness: in transaction mode a request pins a server connection for its whole interactive transaction (about 5-8 round trips), so throughput is roughly `pool_size / tx_duration`.

## Design notes

- **One interactive `$transaction` per request** (`runRequest` in `src/db.ts`): `BEGIN; SELECT resolve_store_id(slug, domain); set_config('app.current_store_id', $1, true); [set_config('app.current_user_id', $1, true)]; handler queries; COMMIT`. `{ maxWait: 5000, timeout: 10000 }` (FWB: 10 s / 30 s; edge requests should be short).
- **GUC names are FWB's:** `app.current_store_id`, `app.current_user_id`. Differences from FWB: FWB runs `SET LOCAL app.x = '<escaped literal>'` through `$executeRawUnsafe`; the spike uses parameterised `set_config(name, $1, true)` (same transaction-local semantics, no string interpolation), plus the same UUID validation.
- **Commit before respond:** the handler returns a plain `{status, body}`; the `Response` is built only after `$transaction` resolves. A COMMIT failure surfaces as a 500 (Hono `onError`), never a 2xx over a lost write.
- **External calls:** handlers queue them with `scope.defer(fn)`; they run after COMMIT via `ctx.waitUntil`, never inside the transaction (FWB's `deferAfterTenantCommit` shape, minus the fresh-tx drain).
- **Prisma client per request, pool `max: 1`.** workerd throws "Cannot perform I/O on behalf of a different request" when a socket/stream created in one request is used from another; a `pg.Pool` caches sockets, so a module-global client breaks under concurrency (per-isolate reuse is only safe with a pool that never survives a request, i.e. no pool). Per-request is cheap here because Hyperdrive/pgbouncer hold the real server connections. `$disconnect()` is fired without awaiting so it stays off the latency path. Not measured: whether the wasm compiler instance can be shared safely per isolate; the client constructor was not a visible cost in the timings.
- **Host -> store before the GUC exists:** `stores` is FORCE-RLS with no grant to `ebda_app`. A `SECURITY DEFINER` function `resolve_store_id(slug, domain)` returns only an id for an exact match; no match = 404, never "first store". The Worker rejects reserved/invalid hosts before opening any transaction. FWB resolves slugs with its RLS-bypass helper instead.
- **Webhook:** WebCrypto `subtle.verify('HMAC')` (constant-time) over the raw body text before any JSON parse; the store comes from the host the provider calls (per-store webhook URL). Inbox insert is `createMany({skipDuplicates})` = `ON CONFLICT DO NOTHING` on unique `(provider, event_id)`, so a replay inserts 0 rows and returns 200. Note FWB's inbox is cross-tenant (no RLS, written under `withRlsBypass`, unique on `idempotency_key`); here it is tenant-scoped RLS and the unique key is global by `(provider, event_id)`.

## Findings (what worked / broke / workarounds)

1. **FWB's policies are allow-contextless, so the "GUC unset returns zero rows" property does not hold for FWB as written.** Every FWB policy is `current_store_id() IS NULL OR store_id = current_store_id()`, so a request that forgets the GUC (or, on a pooler, lands on a connection with no GUC) sees *all tenants*. For Ebda the spike uses strict policies (`store_id = current_store_id()`, NULL -> no rows, inserts rejected) and tests that. Super-admin/cross-tenant paths then need an explicit mechanism (a bypass role or `SECURITY DEFINER` functions); that is a design decision to make, not a free port.
2. **Transaction-local `set_config(..., true)` is safe through a transaction-mode pooler; session-level is not.** 0 leaks in 300 interleaved requests plus targeted reuse probes on a 2-connection pool, and the negative control leaks 13-20/20 times. The mutation check shows the load test only catches the `true->false` regression because of its unscoped probes; plain per-tenant requests re-set the GUC and hide it. Keep that probe pattern in any real test suite.
3. **Prisma 6.19 runs on workerd only with the query compiler (`engineType = "client"`) and the explicit `generated/prisma/wasm.js` entry.** The Rust-engine wasm path was not used. Quirk: `$queryRaw` cannot deserialize Postgres `name` columns (`current_user`, `pg_class.relname`); cast to `::text`. adapter-pg sends no named prepared statements, so pgbouncer 1.22 transaction mode needed no `max_prepared_statements`. Interactive transactions, `upsert` with `{ increment }`, and `createMany({skipDuplicates})` all worked; 12 concurrent increments produced exactly 12 with no P2002/25P02.
4. **Test-tooling friction (workarounds are in the repo):**
   - `npm i` of vitest-pool-workers crashed npm's arborist (`Cannot read properties of null (reading 'edgesOut')`); `npm i --legacy-peer-deps` works. It requires vitest `^4.1`.
   - pg under vitest-pool-workers needs two aliases in `vitest.config.ts`: `pg-protocol` -> its CJS `dist/index.js` (Vite picked `esm/index.js` that has no `"type":"module"`), and `pg-cloudflare` -> `dist/index.js` (Vite's resolver has no `workerd` condition, so it got the empty stub and `CloudflareSocket` was undefined). `wrangler dev` needed neither.
   - `compatibility_date` is capped by the bundled workerd (2026-08-22 for the pool; 2026-09-01 failed to start).
   - The pool bundles a different workerd (1.20260815.1) than `wrangler dev` (1.20261001.1); both were exercised.
5. **Throughput is bounded by `pool_size / transaction duration`.** The one-transaction-per-request model holds a pooled server connection for the whole request (host resolve, two GUCs, handler, COMMIT = 5-8 round trips). With pool 2 and 30-way concurrency p50 rises to ~0.45 s purely from queueing. Hyperdrive's pool size and the number of statements per request will decide real capacity: fewer statements per request (e.g. a single SQL function that resolves the host and sets the GUC in one round trip) is the obvious lever, and keep handlers lean.
6. Minor: a cross-tenant product id in `/cart/items` is a clean 404 (RLS hides it); a webhook for another tenant's cart is a no-op (`cartMarkedPaid:false`); 5 simultaneous webhook replays produce exactly one row.

## Gaps: what a local run cannot prove (to verify on a deployed Hyperdrive)

- Local Hyperdrive in Miniflare is a plain TCP proxy to `localConnectionString`; pgbouncer was added in front deliberately. It does **not** exercise Cloudflare's real pooler (its transaction-mode behaviour, connection reuse policy, pool sizing/limits, query caching, regional placement, TLS to origin, connect/queue latency). Re-run the same suite against a deployed Worker + Hyperdrive config pointing at a real (e.g. Neon/Supabase/RDS) origin as `ebda_app`.
- Hyperdrive **query caching** must be off (or proven safe) for tenant routes: confirm it can never serve one tenant's cached read to another.
- Whether Hyperdrive treats `set_config(..., true)` inside an interactive transaction as pinned for the entire transaction (it must, per its documented transaction-mode semantics; unverified here beyond pgbouncer).
- Real network latencies (Worker in one colo, origin elsewhere): 5-8 round trips per request will dominate; measure p50/p95 and consider fewer statements.
- Worker limits not hit locally: CPU time per request (Prisma wasm compile + query), 6-simultaneous-connection and subrequest limits, bundle size (wasm query compiler; `wrangler deploy --dry-run` size was not checked), memory.
- `$disconnect()` via un-awaited promise: confirm no connection leak on the origin under sustained load on a real Worker.
- Production wiring not covered: auth/JWT -> `userId` GUC (a stand-in header is used), user-scoped policies (`addresses`-style), the cross-tenant/super-admin path under strict policies, migration tooling against Hyperdrive (migrations must go direct to Postgres, not through the pooler).
- Dev credentials (`ebda_app_dev_only`, `dev-only-not-a-real-secret`) are fake and local only.
