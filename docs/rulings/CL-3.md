# CL-3

> Section: 2026-10-01 — backlog batch c-api-lib (branch `fix/backlog-c-api-lib`)

**Ruling CL-3 — RLS helpers assert their precondition instead of documenting it
(issue 2123, issue 2041).** `withScopedRlsBypass` reads `app.bypass_rls` back
after its `SET LOCAL` and throws if it did not persist (a non-transactional
client), so the Ruling W-7 wallet/erasure statements can no longer "succeed"
with RLS still on. `readInStoreContext` reuses an ambient tenant transaction
only when `currentTenantGucs().storeId` matches the requested store; a
store-less (`userContext`) or other-store transaction gets a fresh short
`runInTenantContext` — correct for a read, which is all the helper does.
Both are registered defence mutations (unit tier) and the second is also
proven under a real non-BYPASSRLS login in `rls-ebda-app.test.ts`. Cost if
wrong: one extra short read transaction when a same-store caller arrives
without its GUC recorded — none found.
