# API-HANG-1

> Section: 2026-11-10 — API hangs on cache misses (branch `fix/api-hangs-do-chain`, plan `docs/plans/2026-11-10-api-hangs.md`)

**Ruling API-HANG-1 — every AuthState Durable Object call is bounded at 2.5 s (`AUTH_STATE_TIMEOUT_MS`), and a public cache
fill answers after ONE generation read: its write-back (check, KV put, re-check, delete on a bump) runs in `waitUntil` on
Workers.** Evidence: a cold store resolve made 7 AuthState calls in 20 serial waves on workerd, 6 of them the same generation
read repeated 3x per nested cache level; production `apply` calls were logged `canceled` behind storefront requests cut off at
8 s; no AuthState call had a deadline. The write-back keeps its order and checks, so the NEVER-stale protocol is unchanged, and
`waitUntil` outlives a disconnecting client where the request path did not. A timed-out call surfaces as the AuthState error
every caller already handles (`passOnStoreError` per limiter, a skipped cache write); the RPC is not cancelled, so a `hit` that
lands late is counted, as on a client disconnect. Cost if wrong: if a healthy AuthState call ever needs more than 2.5 s, a
fail-closed limiter (sign-in) answers its outage error instead of waiting, and a `SET NX` lock taken late stays held until its
TTL.
