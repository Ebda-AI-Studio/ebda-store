# Experiment: can FWB's existing Express API run on Cloudflare workerd?

Date 2026-10-03. Scratch copy `/home/user/scratch/fwb-workerd` (disposable; real repo untouched). Time-boxed (~65 tool calls). Not committed.

## Verdict: VIABLE-WITH-WORK for a boot + single-request-at-a-time demo; NOT YET VIABLE for production concurrency. Estimate to "real": 3-5 engineer-weeks for Express-on-workerd, and the remaining blocker (concurrent requests) is the same one Hono would face.

Express boots unmodified under `wrangler dev` via `httpServerHandler` from `cloudflare:node`. /health, storefront product list and cart add work, and `request-transaction.ts` commit-before-respond works. But two or more concurrent requests in one isolate hang (see B9). That must be solved (per-request Prisma client + pg Pool) before this is a real option. The architectural "Express monkey-patching can't work" fear was **not** borne out; the bigger risk is Prisma/pg I/O lifetime across requests, which is framework-independent.

## Versions

- wrangler 4.116.0 (workerd 1.20260730.1; local binary rejects compat date 2026-09-01), Node 22.22, compat date `2026-08-01`, flag `nodejs_compat`.
- @prisma/client / prisma 6.19.3, `@prisma/adapter-pg` 6.19.3, pg 8.23.1, express 4.22.x, Postgres 16, Redis not used (stubbed).
- Prisma generator: `previewFeatures = ["driverAdapters","queryCompiler"]`, `engineType = "client"` (wasm query compiler, 1.95 MB .wasm; no native engine).

## wrangler.jsonc (apps/api)

```jsonc
{
  "name": "fwb-api-workerd",
  "main": "src/worker.ts",
  "compatibility_date": "2026-08-01",
  "compatibility_flags": ["nodejs_compat"],
  "hyperdrive": [
    {
      "binding": "HYPERDRIVE",
      "id": "000...0",
      "localConnectionString": "postgresql://postgres:pw@localhost:5432/fwb_workerd",
    },
  ],
  "vars": {
    "NODE_ENV": "development",
    "PORT": "4000",
    "DATABASE_URL": "...",
    "DIRECT_URL": "...",
    "JWT_SECRET": "...",
    "REDIS_URL": "...",
  },
  "alias": {
    "ioredis": "./cf-stubs/ioredis.mjs",
    "sharp": "./cf-stubs/sharp.mjs",
    "socket.io": "./cf-stubs/noop.mjs",
    "@socket.io/redis-adapter": "./cf-stubs/noop.mjs",
    "rate-limit-redis": "./cf-stubs/noop.mjs",
    "imapflow": "./cf-stubs/noop.mjs",
    "@sentry/node": "./cf-stubs/noop.mjs",
    "@sentry/profiling-node": "./cf-stubs/noop.mjs",
    "@opentelemetry/sdk-node": "./cf-stubs/noop.mjs",
    "@opentelemetry/exporter-trace-otlp-http": "./cf-stubs/noop.mjs",
    "@opentelemetry/auto-instrumentations-node": "./cf-stubs/noop.mjs",
    "@opentelemetry/resources": "./cf-stubs/noop.mjs",
    "@opentelemetry/sdk-trace-base": "./cf-stubs/noop.mjs",
    "@opentelemetry/semantic-conventions": "./cf-stubs/noop.mjs",
    "iconv-lite": "./cf-stubs/iconv-lite.mjs",
    "pino": "./cf-stubs/pino.mjs",
    "compression": "./cf-stubs/compression.mjs",
    "swagger-jsdoc": "./cf-stubs/noop.mjs",
    "swagger-ui-express": "./cf-stubs/noop.mjs",
  },
}
```

## worker.ts (apps/api/src/worker.ts)

```ts
import '../cf-stubs/cf-env-init'; // Hyperdrive getter + boot-time timer shim (see B2)
import { httpServerHandler } from 'cloudflare:node';
import app from './index'; // UNCHANGED index.ts: builds app, createServer(app), listen(4000) as a side effect
import '../cf-stubs/cf-env-done'; // flips __cfBooting=false
void app;
export default httpServerHandler({ port: Number(process.env.PORT || 4000) });
```

`httpServerHandler` exists in this wrangler/workerd; the existing `httpServer.listen(config.port)` in `index.ts` is picked up by it, so index.ts needs no change.

## Source changes (only 3 files outside the Worker shell)

1. `packages/database/prisma/schema.prisma`: preview features + `engineType="client"`.
2. `packages/database/src/index.ts`: `adapter: new PrismaPg({connectionString, Client: LazyUrlClient, max: 1000, maxUses: 1})` instead of `datasourceUrl`; `LazyUrlClient extends pg.Client` resolves `env.HYPERDRIVE.connectionString` at connect time.
3. `apps/api/src/services/auth.service.ts`: `DUMMY_PASSWORD_HASH` made a lazy getter (static initializer did `crypto.randomBytes` + 12-round `bcrypt.hashSync` in global scope).

## Stub list (wrangler `alias`, `apps/api/cf-stubs/`)

| Module                                                          | Stub                                                                                                                                                                                              | Effect                                                                                                    |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| ioredis                                                         | class whose `connect()` rejects                                                                                                                                                                   | RedisService runs in its Redis-down fallback (memory cache, memory CSRF, memory lockout, no queues/locks) |
| rate-limit-redis, socket.io, @socket.io/redis-adapter, imapflow | deep no-op Proxy                                                                                                                                                                                  | rate limiters use memory store; no realtime; no IMAP                                                      |
| @sentry/node, @sentry/profiling-node                            | no-op                                                                                                                                                                                             | no error reporting                                                                                        |
| 6x @opentelemetry/\*                                            | no-op                                                                                                                                                                                             | tracing off (it was opt-in anyway)                                                                        |
| sharp                                                           | throws on call                                                                                                                                                                                    | image resize/PWA icons dead                                                                               |
| swagger-jsdoc, swagger-ui-express                               | no-op                                                                                                                                                                                             | /docs dead                                                                                                |
| pino                                                            | wrapper over `pino/browser` + `transport()` no-op                                                                                                                                                 | console JSON logs (pino resolved to browser build, which has no `transport`)                              |
| iconv-lite                                                      | TextDecoder shim                                                                                                                                                                                  | see B3                                                                                                    |
| compression                                                     | no-op middleware                                                                                                                                                                                  | see B7                                                                                                    |
| (not stubbed, bundled and loaded fine)                          | express, helmet, cors, cookie-parser, express-rate-limit, jsonwebtoken, bcryptjs, zod, inngest, @aws-sdk/\*, resend, exceljs, multer, web-push, qrcode, otplib, @modelcontextprotocol/sdk, dotenv | boot OK; only exercised paths below are verified                                                          |

## Blocker log (in order)

| #   | Blocker                                                                                                                                                                                                                                                                               | Resolution                                                                                                                                                                                                                                                                                                                                                                                |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| B1  | `wrangler dev`: "compat date 2026-09-01 newer than binary (2026-08-06)"                                                                                                                                                                                                               | set `2026-08-01`. Pin a matching wrangler/workerd in CI.                                                                                                                                                                                                                                                                                                                                  |
| B2  | "Disallowed operation in global scope" x3: (a) reading `env.HYPERDRIVE.connectionString` at module load; (b) `setInterval` at module load (`middleware/security.ts:37`, `view-ingest.service.ts:54`, boot IIFE `index.ts:131`); (c) `crypto.randomBytes` in `AuthService` static init | (a) lazy pg Client subclass; (b) `cf-env-init` shims `setTimeout/setInterval` to no-ops until the last import (all FWB background loops therefore stay dead, as the inventory predicted); (c) lazy getter. Only (c) is a real source edit.                                                                                                                                                |
| B3  | `require_streams(...) is not a function` from body-parser -> iconv-lite: esbuild applies iconv-lite's `browser` field which nulls `./streams`                                                                                                                                         | alias to a TextDecoder shim (UTF-8/latin1 only). Fixable properly by `conditions`/`mainFields` config or upgrading deps.                                                                                                                                                                                                                                                                  |
| B4  | `pino.transport is not a function` (pino resolves to browser build)                                                                                                                                                                                                                   | pino shim; Axiom/pino-pretty/file transports gone.                                                                                                                                                                                                                                                                                                                                        |
| B5  | Native Prisma engine cannot load                                                                                                                                                                                                                                                      | wasm query compiler + `@prisma/adapter-pg` (works, ~2 MB wasm).                                                                                                                                                                                                                                                                                                                           |
| B6  | Hyperdrive/pg: **a pooled `pg` connection created in request A and reused/handed over to request B makes B hang** ("Worker's code had hung", 5-10 s then 500). 2nd identical request always failed                                                                                    | `maxUses: 1` (connection discarded after each checkout) fixes sequential traffic.                                                                                                                                                                                                                                                                                                         |
| B7  | `compression` middleware: response headers sent but **body is empty** (node:zlib stream through `res.write` loses data under httpServerHandler) for any body >1 KB / any Accept-Encoding incl. identity                                                                               | alias to no-op (edge compresses anyway).                                                                                                                                                                                                                                                                                                                                                  |
| B8  | Prisma boot BYPASSRLS guard query runs in the `listen` callback at global scope -> fails and logs warning (fail-open)                                                                                                                                                                 | harmless here; must move to first request or CI.                                                                                                                                                                                                                                                                                                                                          |
| B9  | **UNRESOLVED: concurrent requests hang.** 3 parallel authenticated POSTs: 1 succeeds, 2 time out at 10 s (500 `maxWait`/hung); 6 or 8 parallel: 1-2 succeed. Pool `max` 5 -> 1000 did not help.                                                                                       | Likely shared module-level Prisma client / pg Pool / query-compiler instance holding I/O created under another request's context (the same class as B6). Not root-caused within the time box. Needed fix: build `PrismaClient` + pg `Client` per request (inside a middleware, stored in ALS) and `waitUntil` close; cost per request = wasm query-compiler instantiation (not measured). |

## What responded (local `wrangler dev`, Hyperdrive local string, Postgres 16, store+2 products seeded via SQL)

- `GET /health` -> 200, ~4-17 ms.
- `GET /api/v1/public/products` (`x-store-id`) -> 200, 1.7 KB body, 12-170 ms (first request after boot ~170 ms: wasm init + 8 queries); correct JSON from Prisma.
- `POST /api/v1/public/cart/items` -> 200 with full cart JSON, ~95 ms; DB row quantity increments correctly (2 -> 4 -> ... -> 8).
- `POST /api/v1/stores/:storeId/categories` with a hand-minted store_admin JWT (jsonwebtoken verify, issuer/audience, token-version DB fallback, `requireStoreAccess`, `writeLimiter`) -> 201, median ~31 ms warm.
- 404 handler, error handler, helmet headers, express-rate-limit (memory store) headers all present.

## Request lifecycle checks (item 6)

- **request-transaction.ts works.** Postgres `log_statement=all` shows, on ONE backend pid: `BEGIN` -> `SET LOCAL app.current_store_id='...'` -> user lookup -> store lookup -> category selects/insert -> `COMMIT`. The `res.end` monkey-patch, buffering and commit-before-replay behave: in 20 sequential POSTs, the new row was visible to an independent connection immediately after the client received the 201 in **20/20** cases (response sent after COMMIT).
- **AsyncLocalStorage propagates through Express middleware** under `nodejs_compat`: the Prisma proxy found the tenant tx (`tenantStorage`) across `authenticate` -> `tenantContext` -> `requirePermission` -> router -> handler; every statement ran on the tx connection with the GUC set.
- Not tested (time): `res.on('finish'|'close')` rollback on client abort, `COMMIT_TIMEOUT` path, 5xx rollback, `deferAfterTenantCommit` drain (needs `waitUntil`), GUC leakage under concurrency (blocked by B9), RLS as the non-owner `force_app` role (I connected as superuser `postgres`; RLS was NOT actually enforced in this experiment).

## Bundle size (`wrangler deploy --dry-run --outdir`)

- Reported: **Total Upload 12,960.80 KiB (12.7 MB) / gzip 3,100.30 KiB (3.03 MB)** (first build); final build `worker.js` 11.3 MB raw (2.4 MB gzip alone) + 1.95 MB Prisma wasm.
- Limit: 10 MB gzip on paid plan; 3 MB gzip on free (just over). **Fits comfortably (~30%).** Dead-weight (aws-sdk, exceljs, inngest, MCP sdk) could still be trimmed. No startup-CPU measurement: local workerd does not enforce the 1 s startup limit; module init of 143k LoC + 95 inngest functions is the open risk (not measured on real edge).

## Latency

Local only, no network hop to Postgres/Hyperdrive: cold first DB request ~170 ms, warm public list ~12-50 ms, warm tenant write ~31-47 ms. Real edge-to-Neon numbers unknown.

## Interpretation for the decision

- Express-on-Workers is far less hostile than the inventory assumed: the monkey-patching, ALS and Prisma interactive-tx RLS design all work. Stubs are mostly the pieces the plan already scheduled for replacement (Redis, sockets, Sentry, sharp).
- Remaining hard problems: B9 (per-request DB client lifecycle), global-scope init under the 1 s startup limit, all background loops/timers (need Cron/Queues/DO per inventory section 3), Redis-backed features (no shared state => rate limits, CSRF, lockout, caches degrade to per-isolate), and `httpServerHandler` runs one Node `http.Server` emulation per isolate (perf under load unmeasured; compression/stream behaviour already showed one defect).
- Containers remain the zero-rewrite path; Hono rewrite avoids `cloudflare:node` emulation risk but must solve B6/B9 identically.
- Suggested next steps: (1) fix B9 with a per-request PrismaClient and re-run the parallel test and RLS as `force_app`; (2) deploy the dry-run bundle to a real account for startup CPU and Hyperdrive session-pooling check; (3) decide after (1)-(2).
