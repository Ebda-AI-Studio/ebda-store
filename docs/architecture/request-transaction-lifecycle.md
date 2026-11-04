# Request transaction lifecycle (tenantContext) - admin fix pass T1

Rulings: LAZY-TX-1, LAZY-TX-2, LAZY-TX-3, FP-4. Detail of the commit/respond ordering lives in `apps/api/src/middleware/request-transaction.ts`.

## Why this changed

Express runs `router.param('storeId', tenantContext)` before the route's own `authenticate`. `tenantContext` used to lease a pooled client (6 per isolate) and open a 30 s interactive transaction first; `authenticate` then ran its two identity RPCs (no timeout) while that client was held. A dashboard fires 4-6 parallel requests, so a slow identity answer could starve the pool and stall the page (QA saw one 33.5 s response; the runtime effect is INFERRED, settle it with the 6-parallel replay below).

## Order now

1. **Anonymous admin-namespace GET/HEAD** (`/stores/<uuid>/...`, no Authorization, no Cookie): `storeScopeContext`. No client is leased; the route's `authenticate` answers 401 before any query. (The public storefront under `/public` keeps its one-transaction read, LAZY-TX-1/2; writes keep the transaction.)
2. **Identity-service bearer token**: the live check (revocation + account state, 3 s each) runs _before_ BEGIN and is kept in a per-request memo; `authenticate` inside the transaction reuses it. A failure here is ignored on purpose: `authenticate` owns the 401/403/503, and optional-auth routes keep their guest path.
3. Everything else: BEGIN as before.

Server-Timing (`auth`, `identity`, `db-wait`, `handler`, next to `request-tx`) shows which stage a slow request spent its time in.

## Verify (local API + one admin)

1. Fire 6 parallel dashboard GETs with a valid token and 6 with no token; read `Server-Timing`: the unauthenticated ones show `db-wait` 0 / absent and hold no transaction.
2. Replay the 6-parallel load against production after deploy and compare TTFB p95 with the QA figure (goal: p95 < 500 ms for GETs).
