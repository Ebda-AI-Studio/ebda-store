# PERF-BATCH-1

> Section: 2026-11-11 — batch the limiter calls of a request, parallelise the cold store resolve (branch
> `perf/batch-limiter-and-resolve-calls`, plan `docs/plans/2026-11-11-batch-limiter-and-resolve-calls.md`). Follow-up to
> API-HANG-1 / API-HANG-2 (PR #529).

**Ruling PERF-BATCH-1 — every rate-limit hit a request will make is sent to AuthState in ONE call per shard, before the global
limiter runs; each limiter then takes its prefetched result. A batched call that times out applies the STRICTEST fail class
among its members: one fail-closed key in the call fails every member closed, a public read key included. A cold public store
payload starts all its per-store reads at once, and StoreDO reads started in the same microtask share one `query` RPC.**

How:

- `plannedRateLimit(name, options)` (`apps/api/src/middleware/security.ts`) builds the express-rate-limit limiter AND its plan
  (`middleware/limit-plan.ts`) from one options object: store name, window, key function, skip. A plan cannot disagree with its
  limiter. Limiters keyed on state set later in the chain (`req.user`, `res.locals`) are `withoutLimitPlan(..., reason)` and
  count directly: admin search, upload, daily upload, passkey step-up, WhatsApp consent (user, store).
- `prefetchRequestLimits` (`middleware/request-limit-prefetch.ts`) is mounted in place of the global limiter (`app.ts`). It
  walks the API router for the route this request reaches (Express 4 layer regexps; routers detected by shape, not name, the
  bundle is minified) and collects the global plan + every planned limiter and planner (the public router's family) on the
  way. Keys are predicted on a copy of the request whose body went through `sanitizeInput`'s sanitiser and whose cookies
  were parsed, reads delegated to the real request (workerd's `req.socket` is a private field).
- A route whose plan reads the body (per-email sign-in / reset / verify, refresh, MCP writes, contact enquiries) has its JSON
  body parsed by the prefetch, before the global limiter instead of after it. A parse error is held and raised at the parser's
  own place (`raiseHeldBodyError`), so an over-limit request still gets the global 429 first and a malformed body its 400.
- The public router's own prefetch (`public-limit-prefetch.ts`) now adds only the keys the request-level batch did not send,
  into the same map.
- `storePayloadParts` (`routes/public.routes.ts`) starts tax, FAQs/how-tos/unpublished pages, the three opt-in flags, features
  and footer locations together for `/stores/:slugOrId` and `/store/resolve`; `/stores/:slugOrId` stopped reading the
  unpublished page slugs twice. `coalesceReads` (`lib/repo-factory.ts`) folds same-microtask StoreDO read batches into one
  `query` RPC and hands each caller its own slice; when the folded call fails, each batch is re-sent alone so every caller gets
  the answer it would have had alone.

Unchanged: every limiter's key, window, max, headers, 429 body, skip and API-HANG-2 class; the cache-generation protocol (a
fill still reads its generation before its data, so the two nested generation reads of a cold store resolve stay serial); the
response payloads (same values, keys and key order).

Evidence (local workerd, built Worker, 150 ms injected per AuthState call, 30 runs, `workers-test/batch-latency.test.ts`):

| path                                   | before p50 / p95 | after p50 / p95 | limiter calls                        | serial waves (no delay) |
| -------------------------------------- | ---------------- | --------------- | ------------------------------------ | ----------------------- |
| customer sign-in                       | 914 / 940 ms     | 611 / 625 ms    | 3 serial -> 3 parallel (1 per shard) | 9 -> 7                  |
| guest order create (COD)               | 620 / 629 ms     | 320 / 348 ms    | 4 serial -> 4 parallel (1 per shard) | 19 -> 17                |
| cold store resolve                     | 473 / 484 ms     | 472 / 482 ms    | 1 -> 1                               | 15 -> 11                |
| cold store resolve, +40 ms per StoreDO | 760 / 773 ms     | 552 / 563 ms    | StoreDO calls 11 -> 5                | 15 -> 11                |

Cold store resolve with only AuthState delayed is bound by its three AuthState waves (limiter batch + the two nested
generation reads), which this change does not touch; its StoreDO work went from 11 serial calls to 5 calls in 2 waves, worth
~210 ms at a 40 ms StoreDO round trip.

Tests: `tests/unit/request-limit-prefetch.workers.test.ts` (round trips counted per shard and in flight together, and the
same chain without the prefetch shown sequential; rl:auth trips at 16, rl:auth-ip-fail at 61 failures and never on successes,
rl:global at 201, each with its own body; a global 429 takes back the later limiters' hits; malformed body keeps its 400; the
strict class of a mixed timed-out batch, mutation-checked; every router limiter planned or named),
`tests/unit/store-do-read-coalesce.test.ts`, `workers-test/batch-latency.test.ts` (wave and StoreDO-call ceilings),
`workers-test/latency-budget.test.ts` (sign-in 9 -> 7 waves, cart add 15 -> 13, order create ceiling 37 -> 17).

Cost if wrong: a prediction that names a counter the request never reaches adds one hit to that counter until the response
ends (taken back with `unhit` then), so a client sitting exactly at a fail-closed limit can see one early 429 in that window;
and a mixed batch that times out refuses a public read that would otherwise have been served.
