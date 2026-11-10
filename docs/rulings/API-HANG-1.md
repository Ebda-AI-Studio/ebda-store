# API-HANG-1

> Section: 2026-11-10 — API hangs on cache misses (branch `fix/api-hangs-do-chain`, plan `docs/plans/2026-11-10-api-hangs.md`). Amended the same day after review (bounded scope).

**Ruling API-HANG-1 — an AuthState Durable Object call carries a 2.5 s deadline (`AUTH_STATE_TIMEOUT_MS`) ONLY where its caller
has a defined answer to "no reply in time": the rate-limit store (fail mode per API-HANG-2) and cache-generation READS (the fill
skips its write). Generation BUMPS, jti / token-version / lockout / CSRF ops, locks and sweeps stay unbounded, as before. A
public cache fill answers after ONE generation read: its write-back (check, KV put, re-check, delete on a bump) runs in
`waitUntil` on Workers.** Evidence: a cold store resolve made 7 AuthState calls in 20 serial waves on workerd, 6 of them the same
generation read repeated 3x per nested cache level; with a 150 ms AuthState round trip injected (DEV_STATS-only
`x-dev-authstate-delay-ms`), cold store resolve 1073-1102 ms -> 466-471 ms, product list 618-626 -> 310-314 ms, PDP 617-618 ->
309-311 ms. Review blocker fixed: a bounded BUMP let an invalidation delete before its late bump landed, so a fill holding the
old generation re-published stale price/stock for the whole TTL (`tests/unit/public-cache-stale-refill.workers.test.ts`, slow
bump case, fails when the bump is bounded). Cost if wrong: an unbounded call to a stuck instance still holds its request (the
pre-PR behaviour) on the paths left unbounded; a bounded read that times out costs one uncached fill.
