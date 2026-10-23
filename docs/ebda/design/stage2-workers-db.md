# SP4 Stage 2: the database client on Workers, memory, burst and soak (2026-10-04)

Branch `claude/sp4-worker-stage2`, on top of Stage 1 (`stage1-exit-test.md`). Parity is in `stage2-parity.md`.

## Result

On one `wrangler dev` process, one after the other: **3 bursts of 200 concurrent mixed requests and a 1,000-request soak,
0 errors, 0 cross-tenant leaks, 0 leaked leases**, two stores, pgbouncer in transaction mode, API as `ebda_app`, with the
Stage 1 limiter and lockout proof passing after each. Stage 1 could not do a second burst on the same dev server.
Edge behaviour (isolate memory limit, Hyperdrive to Neon) is still unmeasured: it needs Cloudflare credentials.

## The design finding: one client for every concurrent request does not work on workerd

The brief for this stage was one PrismaClient per isolate over a driver adapter that resolves the pg connection of the
current request from AsyncLocalStorage. It was built first (an adapter implementing `SqlDriverAdapterFactory` /
`SqlDriverAdapter` that delegated every `queryRaw`, `executeRaw`, `executeScript` and `startTransaction` to a lazily
opened per-request `@prisma/adapter-pg`, with a transaction gate) and it passed the single-request tests. Under
concurrency it **hangs**: 5 of 40 concurrent transactions never answered, in every run, with no error anywhere. Server
side `pg_stat_activity` showed those sessions `idle in transaction` after `BEGIN` or after a finished `pg_sleep`: the
next statement was never received.

Mechanism, measured rather than inferred:

- Prisma's request DataLoader (one per client) batches calls made in the same tick and dispatches the batch from
  `process.nextTick`. workerd implements `nextTick` as `queueMicrotask`, and its microtask queue is shared: request B's
  continuation can run before request A's dispatch microtask. B's call joins A's batch and is **executed from A's async
  context**. Logging the ALS store inside the adapter showed it (`q start 5 als 4`, `24 als 29`, `26 als 31`: the query
  of request 5 running in request 4's context).
- workerd forbids using request B's I/O object from request A's context. For a pg socket it does not throw: the write is
  lost and the query never answers. Capturing `AsyncLocalStorage.snapshot()` to re-enter B's context fails loudly with
  "Cannot call this AsyncLocalStorage bound function outside of the request in which it was created", which confirms the
  diagnosis and shows there is no way to hop back.
- The same SQL through a client per concurrent request (Stage 1's design) never hung at 40 or 200 concurrent requests,
  and a fresh client per request on the shared adapter still hung, so the culprit is shared Prisma state across
  concurrent requests, not the adapter's logic.

What IS shared already: the wasm query compiler **instance**. Prisma caches it per provider (`loadQueryCompiler`), so
there is one per isolate regardless of the client count. What a client adds, and what costs the ~3.3 MB, is its engine
(a `QueryCompiler` holding the parsed datamodel) and its DataLoader.

## What shipped instead: leased, reused clients (`packages/database/src/client-pool.ts`)

- `ClientPool` per isolate: at most `max` clients (default 6 since 2026-10-23, was 4; `DB_CLIENT_CONCURRENCY`), built lazily, **kept and reused**.
  A request leases one for its whole life (including its post-commit work) and returns it. A client therefore serves one
  request at a time: no shared DataLoader across concurrent requests, no cross-context execution. Requests beyond `max`
  wait (FIFO) up to `DB_CLIENT_WAIT_MS` (6 s since 2026-10-23, was 20 s) and at most `DB_CLIENT_QUEUE` (default `5 * max`) at a time; past either, `ClientPoolTimeout` becomes a `503 OVERLOADED` with `Retry-After` at once. See `docs/incidents/2026-10-23-array-buffer-and-tail.md` for why.
- **Cancelled requests (2026-10-07).** workerd cancels a request whose client disconnects; its pending promises never
  settle, so the `finally` that returns its lease never runs. Measured on the preview API: six probes cut off by the
  client left `leased: 3` with nothing in flight, and once all `max` clients were held by dead requests the isolate
  answered EVERY request `503 OVERLOADED` after 20 s, for the life of the isolate (the builder canvas's server render
  landed on such an isolate: no draft, no products, no editor overlay). The pool now records when each client was handed
  out; at capacity, a lease older than `staleLeaseMs` (15 s since 2026-10-23, was 30 s) is **abandoned** — no
  longer counted, its client never reused, a late release drops it — and a waiter older than `DB_CLIENT_WAIT_MS` is
  skipped as dead. `stats().abandoned` counts them. `tests/unit/cf-client-pool.test.ts` ("cancelled").
- The pg connection stays per request and lazy: each lease gets a `ConnectionScope` (a pg pool of at most
  `connectionsPerRequest` = 3 sockets to the pooler, opened by the first query, ended after the response in
  `ctx.waitUntil`). The pooled client's driver adapter (`LeasedAdapter`) has no socket of its own: it delegates to the
  lease's scope, and refuses with a clear error when there is no lease. Transactions begin on, and stay pinned to, that
  scope (`set_config(..., true)` inside one transaction, as before).
- Stage 1 built and discarded an engine for **every** request. Reusing it is the CPU/GC win: the same burst drains in
  about half the time (below).
- `createIsolateDb(...).run(fn, { waitUntil, beforeDisconnect })` replaces the Stage 1 `ConcurrencyGate`
  (`cf/concurrency-gate.ts` and its test are deleted). The Node runtime is untouched (process singleton, pool of 15).

Three failure modes of reuse were found by the parity run and are closed (details in `stage2-parity.md`):

1. A floating promise that outlives its request would run on the NEXT request's connection, and could leave the client's
   DataLoader with a lost dispatch (`tickActive` stuck true: every later query in a transaction on that client hangs).
   `prisma` now throws "database used after its request ended" for a released lease, a client with a stuck dispatch is
   discarded on release, and `cfWaitUntil` work is awaited before the lease is returned.
2. The API opens a second transaction while the request's is open, so one connection per request deadlocks until pg's
   connect timeout. A request may hold 3.
3. Because of (2), 4 clients can hold 8 pooler connections at worst: the default `max` is 4, not 8 (the pgbouncer pool of
   the exit test is 8). Measured: 4 and 8 drain the same load in the same time (soak p95 534 against 628 ms), because one
   isolate is CPU bound.

## Numbers

Same harness as Stage 1 (`apps/api/scripts/stage1-exit-test.mjs`, now with `--stats`, `--conc`), local workerd, one thread.
`wallMs` for 200 requests in flight at once, Stage 1 in the first row.

| run                                        | wall   | errors | leaks | p50     | p95     | p99     | max     |
| ------------------------------------------ | ------ | ------ | ----- | ------- | ------- | ------- | ------- |
| Stage 1 (client per request), fresh server | 9.0 s  | 0      | 0     | 4958 ms | 7933 ms | 8224 ms | 8228 ms |
| Stage 2 burst 1 (cold, same process)       | 4.4 s  | 0      | 0     | 2359 ms | 3439 ms | 3580 ms | 3603 ms |
| Stage 2 burst 2 (same process)             | 3.6 s  | 0      | 0     | 1546 ms | 2662 ms | 2795 ms | 2817 ms |
| Stage 2 burst 3 (same process)             | 3.6 s  | 0      | 0     | 1521 ms | 2680 ms | 2828 ms | 2849 ms |
| Stage 2 soak, 1,000 requests, 25 in flight | 18.9 s | 0      | 0     | 454 ms  | 646 ms  | 747 ms  | 869 ms  |

After every round `/__dev/stats` reported `created 4 (max 4)`, `leased 0`, `waiting 0`, `discarded 0`; the webhook replay
left exactly one inbox row each time; the limiter proof gave 5 `INVALID_CREDENTIALS`, `ACCOUNT_LOCKED` from the 6th and
`RATE_LIMITED` from the 16th each time. Repeat runs with `DB_CLIENT_CONCURRENCY=8`: 3 bursts 5.0 / 3.6 / 3.0 s and soak
16.1 s, 0 errors. **One of the four complete runs lost the dev server at the start of its third burst** (workerd and
wrangler exited with no error in either log; the Stage 1 section 5 crash, still unexplained, and it did not recur in the
three runs after); the other three, and the soak, completed.

## Memory and boot (lazy loading)

Heap is `Runtime.getHeapUsage` through wrangler's inspector (`apps/api/scripts/cf-heap.mjs`; the inspector in workerd does not
honour `HeapProfiler.collectGarbage`, so a floor is the minimum of a series). `workerd` here has no 128 MB limit.

| measure                                                      | Stage 1          | Stage 2         |
| ------------------------------------------------------------ | ---------------- | --------------- |
| bundle, Total Upload                                         | 13,044 KiB       | 13,530 KiB      |
| bundle, gzip                                                 | 3,063 KiB        | 3,118 KiB       |
| idle JS heap after boot and `/health` traffic                | 57 to 60 MB      | 49 to 51 MB     |
| after the first database request                             | 54.5 MB          | 53.1 MB         |
| engines (3.3 MB each) alive under load                       | up to 8, rebuilt | up to 4, reused |
| peak JS heap under the burst / soak (no GC pressure locally) | 130 to 150 MB    | 133 to 141 MB   |

`exceljs` (6 call sites), the MCP SDK and its tool modules (both MCP routes) and the AWS S3 client (storage service, two
Inngest functions) are now `import()`ed at first use (`apps/api/src/lib/lazy-modules.ts`; `swagger` was already stubbed).
That is about 8 MB off the boot heap. The bundle grew 480 KiB raw (54 KiB gzip) because esbuild cannot tree-shake a
dynamically imported module: the S3 client is re-exported through `lib/s3-bundle.ts` so only the six commands in use come
along (a bare `import('@aws-sdk/client-s3')` was +540 KiB). Headroom against the paid 10 MB gzip limit is unchanged in
substance (3.1 of 10 MB). The peak under load is not lower because it is dominated by request garbage that a local
workerd never has to collect; whether 4 engines plus a 50 MB floor fit the real 128 MB is the first thing to measure on the
edge. `react-dom` / `prettier` from email rendering (about 1 MB) were not moved.

## Tests

- `tests/unit/cf-client-pool.test.ts` (12): lazy build, reuse, FIFO waiters, timeout without a leaked waiter, idempotent
  release, lease refused outside a request, a stuck client dropped (and replaced for a waiting request), a floating promise
  refused after release.
- `tests/integration/rls-pooler-isolation.test.ts` (+6, 11 passing, the pooler tests of Stage 1a unchanged): the 300
  interleaved requests for two stores and contextless ones now also run on leased clients; overlapping requests hold
  different connections and clients; reuse on a fresh connection; waiting beyond the pool; pool timeout; a nested
  transaction does not deadlock, with a one-connection negative control.
- `apps/api/workers-test/db-scope.test.ts` (4, workerd): two concurrent requests use different connections and different
  clients, sequential requests reuse the client on a new connection, 40 concurrent requests leave nothing leased, a
  request may hold a second transaction. **Mutation checks:** caching the pg connection at isolate scope turned
  the three connection tests red (and 5 of the DB tests of the entry file); setting `connectionsPerRequest` to 1 turned
  the nested-transaction test red.
- `apps/api/workers-test` 29 tests, `npm run test:unit`, typecheck, lint: see the commit that closes the stage.

## Left

- Isolate memory, cold start and Hyperdrive behaviour on the real edge (credentials).
- The Stage 1 dev-server crash (one occurrence in four runs this time).
- The floating promises that do not hold a lease (about 70 `void x()` statements in `apps/api/src`): the guard now turns
  each one that touches `prisma` after the response into a logged error instead of a wrong-connection query, but only the
  ones the buy flow exercises were moved to `cfWaitUntil`. Grep for the log line "database used after its request ended".
- Strict RLS for the payment routes (see `stage2-parity.md`).
