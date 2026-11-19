# Batch the limiter calls, parallelise the cold store resolve (PERF-BATCH-1)

Branch `perf/batch-limiter-and-resolve-calls`. Ruling: `docs/rulings/PERF-BATCH-1.md`. Follow-up to
`docs/plans/2026-11-10-api-hangs.md` (its "Not in this PR" items 1 and 3).

## Finish line

- **Must work:** every rate-limit hit of a request is one AuthState call per shard, all in flight together (sign-in, OTP /
  verify, password reset, refresh, register, order create, cart writes, checkout, MCP, contact enquiries: any route stacking
  2+ limiters, the global one included); a timed-out batched call applies the strictest fail class among its members; a cold
  store resolve reads its store data in parallel.
- **Exercised:** `POST /auth/login`, `POST /public/orders` (guest COD), `POST /public/cart/items`, cold
  `GET /public/stores/:slug` on workerd (`workers-test/batch-latency.test.ts`, `latency-budget.test.ts`,
  `api-hang-concurrency.test.ts`, `public-do-calls.test.ts`, `failure-only-limiters.test.ts`); the real limiters through
  express in `tests/unit/request-limit-prefetch.workers.test.ts`.
- **Must NOT change:** any limiter's key, window, max, headers, 429 body, skip or API-HANG-2 class; the cache-generation
  protocol; payload values / keys / order of `/stores/:slugOrId` and `/store/resolve`.
- **Done:** PR open, CI green, not merged, not deployed.

## Changes

1. `middleware/limit-plan.ts` (new): the plan type, `withLimitPlan` / `withoutLimitPlan` / `withLimitPlanner`, the Express 4
   router walk (`plannedSteps`) and the completeness helper (`allLimiterHandles`).
2. `middleware/security.ts`: `plannedRateLimit(name, options)`; every limiter built through it except the six keyed on
   later state (`withoutLimitPlan` with the reason); `sanitizedBody` for prediction. Same in `routes/mcp-admin.routes.ts` and
   `middleware/contact-enquiry-limiters.ts`.
3. `middleware/request-limit-prefetch.ts` (new) + `app.ts`: the request-level prefetch in place of the global limiter; one
   JSON body parser and one cookie parser instance shared with the prediction; `raiseHeldBodyError` before the parser.
4. `cf/rate-limit-store.ts`: `prefetchHits` adds into an existing map and records each call's strictest class
   (`batchFailsClosed`); `CfRateLimitStore` applies it on a timeout. `public-limit-prefetch.ts` merges into the request map.
5. `routes/public.routes.ts`: `storePayloadParts` for both store payload fills. `lib/repo-factory.ts`: `coalesceReads`.
6. `lib/io-tally.ts` + `lib/request-timing.ts`: DEV_STATS-only `x-dev-storedo-delay-ms` (a StoreDO round trip for the
   measurement, like `x-dev-authstate-delay-ms`).

## Measured

See the ruling's table (local workerd, 150 ms per AuthState call, 30 runs): sign-in p50 914 -> 611 ms, order create
620 -> 320 ms, cold store resolve StoreDO calls 11 -> 5 (760 -> 552 ms with 40 ms per StoreDO call).

## Not changed (and why)

- The two nested cache-generation reads of a cold store resolve stay serial: a fill must read its generation before its data
  (NEVER-stale protocol, API-HANG-1); reading the inner one alongside the outer would be correct only if it still lands before
  the inner data read, a separate change to the generation protocol, not a batching one.
- The coupon distinct-code gate (`couponAttemptLimiter`) stays conditional: its second and third counter calls depend on the
  first's answer, so they cannot be predicted; it only runs on a request that carries a coupon code.

## Verify

- `npx vitest run tests/unit/request-limit-prefetch.workers.test.ts tests/unit/store-do-read-coalesce.test.ts`
- `cd apps/api && npm run cf:dry-run && npx vitest run --config vitest.workers.config.mts workers-test/batch-latency.test.ts workers-test/latency-budget.test.ts`
