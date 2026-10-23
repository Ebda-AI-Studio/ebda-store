# Incident 2026-10-23: "Invalid array buffer length" + 20 s tail on ebda-api

Resume notes (append as you go). Worktree: ~/Desktop/projects/\_worktrees/ebda-store\_\_fix-pool-saturation-array-buffer (branch fix/pool-saturation-array-buffer).

## Findings so far

- (b) HYPOTHESIS (code-read, not yet measured live): the 20.0 s cap = ClientPool `maxWaitMs` default 20_000
  (packages/database/src/client-pool.ts) -> ClientPoolTimeout -> 503 OVERLOADED (apps/api/src/worker.ts handle()).
  Pool = 4 Prisma clients per isolate, one lease held for the WHOLE request (incl. KV/DO hops 1-2 s); stale-lease reclaim 30 s
  after a cancelled request (clientDisconnected ~15%).
- (a) not yet attributed. Candidates: pg-protocol Parser allocating from a garbage length (socket desync) or isolate memory pressure.

## Evidence log (measured unless noted)

- CF GraphQL ebda-api hour 23Z reproduced: success 3068 (wall p50 0.72 s, p90 13.0 s, p99 20.7 s), clientDisconnected 557.
- Zone GraphQL (httpRequestsAdaptiveGroups, api.ebda.app, zone 221191e3...): edge 503 est. ~257 (OVERLOADED path), 499 ~2,450, 500 ~18 (all /public/products, 23:40 bucket = the Prisma errors). 503s spread over 23:20-00:00, i.e. pool-wait timeouts for 40 min; the array-buffer errors are only the 23:41:09 burst + 1 at 23:48.
- 499 hot paths: /public/stores/<id>/pages/cart (722+200+25), /stores/public/<id>/shipping (220), bundle-savings (100). 200 hot paths: /public/cart 1761, /public/products 1611, store/resolve 781.
- Sentry: all 12 events span different queries in the same ~1 s window => isolate-wide transient, not one bad query.
- Node fuzz of pg-protocol Parser with corrupted/desynced streams yields "Invalid array length"/ERR_OUT_OF_RANGE, NOT "Invalid array buffer length" (so a plain socket desync parsed by pg-protocol in Node does not explain the text; workerd Buffer not tested).
- workerd binary contains V8 string "Array buffer allocation failed" (OOM text), so plain OOM would read that, not "Invalid array buffer length" (= a bad LENGTH argument).

## (b) ROOT CAUSE of the 20 s tail (measured + code)

- Per-request CPU is ~9 ms (workersInvocationsAdaptive cpuTimeP50 8,713 us) against wall p50 720 ms: the isolate is I/O bound, not CPU bound.
  The pool, not the CPU, caps it: 4 clients x ~0.7-1 s hold = ~5 req/s per isolate. A request leases a client BEFORE middleware
  (DO hops, rate limit, auth) and holds it for the whole request.
- Live check 2026-10-23 00:11Z, 40 concurrent GETs of one read-only collection page: latencies come in steps (18 at ~1.2 s, 10 at ~2.0 s, 12 at 2.4-3.2 s) = a queue behind a fixed slot count. Scale that to the audit's hundreds of concurrent calls and the wait reaches ClientPool.maxWaitMs = 20_000 ms exactly = the p99 20.0 s. Waiters older than that become 503 OVERLOADED (~257 edge 503s in the hour); callers that left meanwhile are the 499/clientDisconnected (557 invocations, 15%).
- No client-side 20 s timeout exists: the only abort in apps/web/src/lib/api.ts is 45 s. So 20 s is the pool.
- Cancelled requests keep their lease until staleLeaseMs (30 s): at 15% cancellations that removes slots from an already small pool (the 2026-10-07 measurement in client-pool.ts is the same failure).

## Fix (this branch): bounded queue by count (5 x max) and time (6 s), max 4 -> 6, dead-waiter pruning + abort-signal removal, stats().shed (stale lease stays 30 s: review showed 15 s lets live reclaimed requests exceed max engines), and RangeError capture at the adapter (Sentry tag site=prisma-adapter, with pool stats) so the next "Invalid array buffer length" carries its own stack.

## (a) STATUS: NOT ATTRIBUTED. Not reproduced; see evidence log. Unproven candidates, in order: (1) memory/ArrayBuffer pressure of an isolate carrying hundreds of queued requests (all 12 events in one 1 s window across different queries = isolate-wide and transient; 100% inside the 40-minute saturation storm; none before or after), (2) pg-protocol/Hyperdrive framing glitch (would not give this text in Node, workerd untested), (3) Prisma wasm glue. The new adapter hook settles it on the next occurrence.

## Review notes
- request.signal abort path is best effort and UNVERIFIED in prod: a wrangler dev disconnect test never fires it (the dev proxy does not propagate the disconnect, with or without `enable_request_signal`). The age-based pruneDeadWaiters (maxWaitMs) is the proven defence; do not add the flag without a real-edge test.
- Aborted waiters return 499 with no "shed" log (ClientPoolTimeout.reason = 'aborted').
