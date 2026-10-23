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

## RECURRENCE 2026-10-23 09:24:14-15Z and 09:32:41-42Z (release b0ce749, i.e. WITH #161): 13 events, issues 7, 9, B, C, D

Hypothesis tested: isolate memory pressure (6 clients x ~3.3 MB compiler).

- CF analytics, hour 09Z and per minute 09:20-09:36 (measured): statuses are ONLY success and clientDisconnected. No exceededMemory/exceededResources/exceededCpu. Load ~75-140 req/min, success wall p99 2.6-7.4 s (no 20 s tail, no 503 storm). So it is neither queue saturation nor a memory kill.
- Error text: V8 raises "Invalid array buffer length" for a bad LENGTH argument; an allocation failure reads "Array buffer allocation failed" (both strings are in the workerd binary). Not an OOM message.
- Site: `site=prisma-adapter` EMPTY on all events => not raised under LeasedAdapter.queryRaw/executeRaw/executeScript/startTransaction or the Transaction methods (all guarded). Prisma 6.19.3 ClientEngine.request: errors from queryCompiler.compile and from #ensureStarted (QueryCompiler construction) are turned into PrismaClientUnknownRequestError(message) with the stack dropped (#transformCompileError / handleRequestError). Failing ops: product.findMany/count, productOption.findMany, bundle.findMany, store.findUnique, cart.findFirst, $queryRaw: any model, so not data-dependent.
- Prisma source (srcof @prisma/client@6.19.3): no `new ArrayBuffer(n)` with a computed length in client/, client-engine-runtime/ or adapter-pg/; only `new Uint8Array(buffer, off, len)` (would read "Invalid typed array length"). The wasm-bindgen glue (query_compiler_bg.js) is the remaining JS that touches memory.buffer / TextDecoder / TextEncoder. Loader caches the wasm instance as a promise per provider, so a double-instantiation race is ruled out.
- Memory cost per client (node, measured): +4.5 MB RSS each (wasm linear memory), +33 MB for the first (module). 4 vs 6 clients = +9 MB. Pre-#161 (4 clients) also failed, so #161 is not the cause.
- Local repro NOT achieved: wrangler dev workerd has no 128 MB cap (wasm Memory 64 x 1 GB, 200 x 256 MB ArrayBuffers all succeeded) and its proxy dies under 150-way bursts.
- Wasm-in-workerd quirk checked: ArrayBuffer(-1) gives exactly "Invalid array buffer length"; Buffer.alloc(-1) gives "Invalid typed array length"; Buffer.allocUnsafe(>=2^31) gives ERR_OUT_OF_RANGE.

### Change (fix/array-buffer-recurrence)

Pool now wraps every pooled client with a Prisma query extension: a Prisma-internal "Invalid array buffer length" is reported to Sentry (tag site=prisma-request, model, op, extra: clientUses, clientAgeMs, pool stats) and the failing client is DROPPED on release (fresh client + QueryCompiler for the next request). This does not fix the unknown origin; it (1) tells us whether failures hit freshly built clients (clientUses=1 => QueryCompiler construction) or old ones (compile on a long-lived shared wasm instance), and (2) stops one bad client from serving more requests.

### Open / next

If clientUses is always 1: pre-build/warm clients at isolate start, sequentially, outside request bursts. If old clients: suspect the shared wasm instance (cannot be replaced from outside Prisma; next step is a repro under a real 128 MB cap with `wrangler deploy` of a stress Worker to a scratch name on the personal account, or upgrading @prisma/client).

Review notes (PR #168): an adapter-raised RangeError fires both tags (site=prisma-adapter, then site=prisma-request); a Prisma-internal one fires only prisma-request, which is how to tell them apart. A batch $transaction([..]) of N ops reports N times. A client poisoned after release is dropped at the next take().

## ROOT CAUSE FOUND (round 3, release aaaafb3, issue EBDA-API-F raw stack)

Stack (innermost first): Uint8Array.subarray <- wasm-bindgen glue <- wasm <- `new QueryCompiler` (client construction), pool stats at the failure: `abandoned: 27, discarded: 5, shed: 20`. Other events (clientUses 3-8, age 32-388 s) are warm clients failing after the shared wasm memory was exhausted.

- All pooled clients share ONE wasm instance (Prisma caches it per provider). Each client's QueryCompiler takes ~4.5 MB of its linear memory, which never shrinks; only `$disconnect()` (ClientEngine.stop -> queryCompiler.free()) returns it.
- MEASURED (node, stub adapter, mem.mjs): 60 clients never disconnected = RSS 316 MB; the same 60 disconnected = 80 MB flat. Test: 25 abandon cycles grew RSS 115 MB before the fix, < 50 MB after.
- A lease abandoned as stale (its request was cancelled, ~5-15% of audit traffic) was never disconnected (nothing releases a cancelled request), so each leaked one compiler. 27 abandoned + 5 discarded in one isolate = >140 MB of wasm memory against a 128 MB isolate: construction/growth then fails inside the glue with RangeError "Invalid array buffer length". Explains why it was isolate-wide, bursty (cancellations come with the headless-audit bursts) and only after the isolate had lived a while. #161 (6 clients) raised the ceiling slightly; #168's drop-and-rebuild did not leak (it disconnects).
- Fix: reclaimStale() now `$disconnect()`s the abandoned client at once. Live engines per isolate are bounded by `max` again.
