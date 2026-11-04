# NZ-SF-1

> Section: NEON-ZERO storefront + cart (2026-11-04)

**Ruling NZ-SF-1 - a store on its Durable Object opens no Postgres transaction for a request; it
runs in a bare store scope.** `tenantContext` (every `/stores/:storeId/*` router and every storefront GET through
`publicStoreContext`) and `readInStoreContext` used to lease a pooled Postgres client and BEGIN before the handler ran, so a DO
store's storefront failed the moment Postgres was unreachable although every read it makes is answered by its Durable Object, D1
or KV. They now read the store's backend first (the repo scope's per-request memo, the same read the handler's `storeDb` reuses,
NZ-D7) and, for a `do` store, run the request in `runInStoreScope`: the code-level tenant guard still sees the store, nothing is
leased, and a read that is not ported yet fails at that read (a per-query short transaction, loud when Postgres is down) instead
of at the door. A Postgres store keeps its one request transaction byte for byte; an unreadable or unknown flag is the 503 / 404
of `backendFor`, never a fallback to a transaction. Writes were already on `storeScopeContext` (no transaction). `inDoStoreScope`
gives a handler that resolved its store the same scope for its several reads (settings, tax, features, entitlements).
Supersedes the 2026-11-02 #382 hotfix guard ("a DO store still gets its tenant context"): that test now pins the opposite.
Evidence: `tests/unit/tenant-context-do-store.test.ts`, `tests/unit/store-scoped-read-ambient-match.test.ts`,
`tests/unit/storefront-do-reads.test.ts`, `apps/api/workers-test/pg-unreachable.test.ts` (Postgres at a dead port). Cost if
wrong: a DO-store handler that still reads Postgres inside this scope runs each such read in its own short transaction instead of
the request's single one, so two such reads in one request are no longer atomic with each other.
