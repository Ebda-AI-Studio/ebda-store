# SP4 Stage 1 exit test and status (2026-10-04)

Branch `claude/sp4-worker`. Design: `cloudflare-backend.md` section 8. Ruling: R-EBDA-001.

**Result: the exit test passes.** 200 concurrent mixed requests across 2 stores, against `wrangler dev` (workerd), Postgres behind pgbouncer in transaction mode, the API connected as `ebda_app` (NOBYPASSRLS): **0 errors and 0 cross-tenant leaks in 3 of 3 runs**, each against a fresh dev server. The concurrency hang (experiment B9) is fixed by the per-request client. Two things in this document are not good news and are stated plainly: isolate memory (section 4) and a dev-server crash on a second back-to-back burst (section 5). Neither has been proven on the real edge; that needs credentials (section 7).

## 1. What was run

```
bash apps/api/scripts/cf-pooler.sh start          # pgbouncer 1.22, pool_mode=transaction, pool 8, :6433
su postgres -c "psql -d ebda_s1 -f apps/api/scripts/cf-seed.sql"   # two tenants: alpha, bravo, 6 products each
cd apps/api && npx wrangler dev --port 8799 --local
node apps/api/scripts/stage1-exit-test.mjs --rounds 1 --n 200      # or: bash apps/api/scripts/stage1-exit-run.sh 3 200
```

`ebda_s1` is the repo's migrations applied to an empty database (including `20261004000000_ebda_strict_rls`). The Worker reaches it through the Hyperdrive binding's `localConnectionString` (pgbouncer, role `ebda_app`). The Worker's startup role check logs `current_user=ebda_app rolbypassrls=false`.

The mix of 200 (all in flight at once, each from its own `cf-connecting-ip` so the per-IP limiters do not mask the result):

| kind      | n   | what it checks                                                                                                                                    |
| --------- | --- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| catalogue | 80  | `GET /public/products` for store A or B, selected by the `x-store-domain` host header. Every product returned must carry that store's id and tag. |
| detail    | 20  | `GET /public/products/:slug`, same check.                                                                                                         |
| cart      | 60  | `POST /public/cart/items` (interactive transaction, commit before response). The cart and every item must belong to the host's store.             |
| hostile   | 10  | the same write with the OTHER store's product id. Must be refused (404). A 2xx is a leak.                                                         |
| webhook   | 20  | one HMAC-signed `POST /webhooks/payment/tap` body replayed 20 times. All 200, and exactly one `webhook_events` row for the idempotency key.       |
| health    | 10  | `/health`.                                                                                                                                        |

After the burst the script also asks the database (as the owner) for any `cart_items` whose product belongs to a different store than its cart. And, outside the 200, it proves the Durable Object limiter and lockout trip for ONE client: 18 wrong-password logins for one email from one IP must give 5 `INVALID_CREDENTIALS`, then `ACCOUNT_LOCKED`, and `RATE_LIMITED` from the 16th (the auth limiter is 15 / 15 min per IP + email).

## 2. Numbers

Three runs, each on a fresh `wrangler dev` (cold isolate), raw JSON in the run output; workerd is one thread locally, so 200 in flight queue behind each other.

| run | wall  | errors | leaks | p50     | p95     | p99     | max     |
| --- | ----- | ------ | ----- | ------- | ------- | ------- | ------- |
| 1   | 9.0 s | 0      | 0     | 4958 ms | 7933 ms | 8224 ms | 8228 ms |
| 2   | 9.2 s | 0      | 0     | 4942 ms | 8147 ms | 8411 ms | 8415 ms |
| 3   | 8.9 s | 0      | 0     | 4692 ms | 7867 ms | 8099 ms | 8111 ms |

Per kind, run 1 (p50 / p95 ms): catalogue 4406 / 7851, detail 4445 / 7918, cart 5098 / 8222, hostile 4755 / 8169, webhook 4586 / 8067, health 1415 / 7409. Runs 2 and 3 are within 5%. Webhook inbox rows: 1 each run. Limiter proof, all three runs: 5 invalid, lockout at the 6th attempt, rate limit at the 16th.

The latency is queueing, not service time: about 45 ms of CPU per request on one local thread is 22 requests per second, so 200 at once drain in about 9 s. The same Worker answered sequential requests (one client, warm) at:

| request                                            | p50             | p95    |
| -------------------------------------------------- | --------------- | ------ |
| `/health`                                          | 5 ms            | 8 ms   |
| catalogue read, KV hit                             | 55 ms           | 69 ms  |
| catalogue read, uncached (host lookup + 8 queries) | 91 ms           | 141 ms |
| cart write (transaction, commit before respond)    | 121 ms          | 156 ms |
| first request on a cold isolate / first DB request | 108 ms / 158 ms |        |

Real edge latency, with Hyperdrive to Neon, is not measured (section 7).

## 3. What changed to get there

- **B9, the concurrency hang.** One Prisma client per request (`max: 1`, `runWithRequestDb`), closed through `ctx.waitUntil` after the post-commit deferred work drained on it. 8 parallel authenticated tenant requests: 8 of 8 answer 200 (experiment: 1 of 3).
- The experiment's other blockers are gone by construction, not by shim: no module-load timers (`app.ts` has no side effects, `index.ts` is the Node-only shell), no `bcrypt.hashSync` at import, config does not demand `DATABASE_URL` on Workers, compression is not installed there, `iconv-lite` and `pino` are replaced, the BYPASSRLS guard runs on the first request of an isolate.
- A late socket error from a closing pg connection (`Network connection lost` from pg-cloudflare's read loop) reaches the `pg.Client` after pg-pool detached its listener and threw inside a promise chain. The client now has a no-op `error` listener (`packages/database/src/client.ts`).

## 4. Memory: the number to watch

Each request-bound Prisma client owns an instance of the wasm query compiler. Measured on Node: **about 3.3 MB of external memory per live client** (31 live clients = +108 MB), and no growth over 120 sequential create / query / disconnect cycles, so it is a per-live-client cost, not a leak. Measured in workerd through the inspector (`Runtime.getHeapUsage`):

- idle JS heap after boot: **59 MB** (bundle 13.0 MB raw, 3.06 MB gzip; 79 Inngest functions, Express, zod, exceljs, the MCP SDK, ...);
- live heap after warm-up (floor after major GCs under `/health` traffic): **85 to 100 MB**; peaks of 130 to 150 MB between GCs;
- a Workers isolate has **128 MB** shared by every request it serves. Local workerd does not enforce that, so the production behaviour is unmeasured. The risk is real and is the main thing Stage 2 must measure on the edge.

Mitigations in this change: a gate caps live clients per isolate (default 8, `DB_CLIENT_CONCURRENCY`; waiters queue up to 20 s, `DB_CLIENT_WAIT_MS`, then a 503 with `Retry-After` instead of an isolate kill), no Prisma query logging on Workers, no in-process L1 cache. Measured levers, not yet applied (they change FWB code paths and twin-diff portability, so they are a Stage 2 decision): lazy-load `exceljs` (-6.4 MB heap at boot), the MCP SDK (-7.3 MB), `@aws-sdk/client-s3` (-2.9 MB), `react-dom`/`prettier` pulled in by email rendering (-1.0 MB). With exceljs, MCP and aws stubbed out, the dev-server crash in section 5 moved from the second burst to the third, which points at heap pressure.

If the edge shows isolates dying under sustained load, the design's fallback applies: Cloudflare Containers for the API only (R-EBDA-001).

## 5. A dev-server crash that is not explained

A single 200-way burst against a fresh `wrangler dev` always passes. A SECOND large burst on the same dev server (300 cached catalogue GETs, twice or three times; or the exit test with `--rounds 2`) kills `wrangler dev`: workerd logs `Connection reset by peer` and `Uncaught (in promise): Network connection lost`, wrangler's ProxyWorker reports `Error inside ProxyWorker` and the process exits 1. It reproduces with plain `curl` waves, so it is not the test client; it does not reproduce for Express routes that never touch the database or for Durable Object / KV only routes (300 x 3); it was not Hyperdrive/pgbouncer (same with a direct Postgres connection string); stubbing 16 MB of heap pushed it one burst later. It is not root-caused. `stage1-exit-run.sh` therefore starts a fresh dev server per run and refuses to start while something still answers on the port. A multi-round run is available (`--rounds N`) but expect it to die on this.

An earlier cause of identical-looking dev-server deaths was environmental and is worth knowing: `ebda_app` is a cluster-wide role, and `tests/integration/rls-*.test.ts` run `ALTER ROLE ebda_app ... PASSWORD 'ci-only-app-pw'`. Anything else using another password for it (the SP3 spike used a different one) is broken by the next test run. Everything here uses `ci-only-app-pw`.

## 6. Bundle

`npm run -w apps/api cf:dry-run` (`wrangler deploy --dry-run --outdir dist-cf`, Node 22, wrangler 4.116.0): **Total Upload 13,037 KiB (12.7 MB) / gzip 3,061 KiB (2.99 MB)**, plus the 1.95 MB query-compiler wasm inside that total. The paid-plan limit is 10 MB gzip, so it fits with about 70% headroom. It is 12 KiB under the free plan's 3 MB gzip limit; do not read that as room. Largest contributors by source size: app code about 6 MB with its generated client, exceljs 2.0, @sentry/conventions 0.8, @sentry/core 0.7, zod 0.56, prettier 0.27 (who pulls it in is worth finding), @smithy/core 0.26, ajv 0.21.

## 7. Status against design section 5 and what is left

Runs on Workers now (all in this branch, Node behaviour unchanged):

| area                                                                 | on Workers                                                                                                                                                                           |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| API                                                                  | Express through `cloudflare:node`, per-request Prisma client over Hyperdrive (caching off), strict RLS as `ebda_app`                                                                 |
| token denylist, `tv`, MFA / lockout counters, CSRF, locks, sentinels | `AuthState` Durable Object (SQLite, 32 shards, atomic) behind the ioredis-shaped client; the ~40 `getClient()` call sites are unchanged                                              |
| auth and all other rate limits                                       | express-rate-limit Store on the same DO (exact); Workers Rate Limiting binding as a coarse per-IP flood guard in front of Express                                                    |
| caches                                                               | KV (`cache:*`, 60 s floor), no in-process L1                                                                                                                                         |
| email / SMS queues                                                   | Cloudflare Queues, producer + consumer, retries with growing delay, DLQ consumers park on `email:failed` / `sms:failed` for the replay pages, "Retry all" produces back to the queue |
| in-process timers                                                    | `scheduled()` for abandoned carts (15 min), carrier tracking (30 min), refresh-token cleanup (12 h), loyalty (24 h); schedules pinned to wrangler.jsonc by a test                    |
| socket.io                                                            | `StoreRealtime` Durable Object, hibernating WebSockets, Socket.IO v4 protocol subset, same event names; auth through the API's own `authenticate`                                    |
| Sentry, logging                                                      | `@sentry/cloudflare` (`withSentry`), console JSON logger with the pino redaction list                                                                                                |
| multer, SSRF guard, Inngest                                          | `Request.formData()` shim; DoH + IP blocklist; Inngest served by Express on the Worker (`GET /api/v1/inngest` introspection verified: 79 functions)                                  |

Stubbed or not done (precise):

1. **Not proven on the edge:** isolate memory (section 4), cold start and CPU for the 13 MB bundle, real Hyperdrive pooling of transaction-local GUCs, Neon latency. Needs a Cloudflare API token and a Neon project/branch (Hyperdrive config: `scripts/cf-hyperdrive-create.sh`, caching disabled). Also needed: real ids for `hyperdrive`, `kv_namespaces` in wrangler.jsonc, `wrangler secret put` for `JWT_SECRET`, `ENCRYPTION_KEY`, `INNGEST_SIGNING_KEY`, `INNGEST_EVENT_KEY`, `SENTRY_DSN`, `ALERTS_WEBHOOK_TOKEN`, provider keys.
2. **Inngest:** served and introspectable, but one event and one cron were not run end to end (needs the Inngest dev server or cloud). After each deploy a `PUT /api/v1/inngest` must register the functions (the Node boot self-PUT is gone). CPU per step on `bulk-*` and `campaign-send` is unmeasured.
3. **Images:** `sharp` is no longer imported anywhere in the API (Ruling FU46-8, gate `tests/unit/no-sharp-in-api.test.ts`). Uploads are stored as sent on every runtime (no 2000 px ceiling, no aspect crop); the PWA icon source must be a square PNG of 512×512+ (≤ 1 MB, checked from its bytes) and is stored unchanged under every icon size; Gemini receives JPEG/PNG/WebP/HEIC only, and a GIF/SVG image is refused with a clear error. Still open: Cloudflare Images (resize on delivery or the `IMAGES` binding), not wired.
4. **Realtime:** the DO path is tested to the WebSocket handshake and the refusal paths. The success path (a token the API vouches for, `subscribe:store`, an emitted event arriving) is covered only by unit tests on the emit side; it needs the API reachable from the DO (`API_URL`), which the workerd test environment does not provide. The admin client now uses `transports: ['websocket']` and `uid`; its UI was not run against it.
5. **Cron/queue consumers against a real database** were exercised for the dead-letter path only; the main-queue delivery success path (a configured email provider) and `scheduled()` jobs were not run.
6. **Not touched:** `web-push` (node `https` + ECDH; rewrite on WebCrypto), `expense-ocr` (node `http`/`https` stream download), `@opentelemetry` (only `tracing.ts`, Node shell), `swagger-ui` (moves to docs.ebda.app), `exceljs` streaming export (`bulk/export.xlsx` streams inside a transaction), the campaign pacer and leader locks are DO-backed but their Inngest callers were not run, MCP transport (`res.on('close')`) not run on Workers, `res.on('close')` rollback on client abort not run on Workers.
7. **Parity harness** `--api-url` mode (design section 8, item 3) is not done; buy-flow parity is therefore NOT claimed. The exit test here is the concurrency/leak half of the stage-1 exit criterion.
8. **Memory levers** of section 4 and the unexplained dev-server crash of section 5.
9. `CF_VERSION_METADATA.id` is the deploymentId; `BUILD_COMMIT_SHA` must be passed with `--var` at deploy.

## 8. Tests added

- `apps/api/workers-test` (`npm run -w apps/api cf:test`, 25 tests on workerd via `@cloudflare/vitest-pool-workers`, against the BUILT bundle loaded in a second Miniflare worker; the 6 database tests run only when the local pgbouncer path is up). Mutation-checked: `CfRedis.exists()` returning 0 turns "a revoked jti is rejected on the very next request" red.
- Node unit tests: the AuthState command engine on `node:sqlite` (24), the Workers redis client (24), the limiter store (6), the queue consumer (11), the gate (5), the console logger (8), the realtime emit path (5), the multer shim (8), the DoH SSRF guard (15), wrangler.jsonc and the caching-off script (11).
- The Node API as `ebda_app` against a migrated database: 18 integration files touching auth, token revocation, MFA, carts, the deferred-work drain, the pacer and caches, 140 tests green.
