# FRT-3

> Section: 2026-10-01 — Finance Reports count store-local days (`fix/finance-reports-store-tz`)

**Ruling FRT-3 — the store time-zone lookup is a bare read, not its own tenant transaction (issue
2410).** `runInTenantContext` never joins an ambient transaction, so wrapping `storeTimeZone` in it
took each finance report request from 2 interactive Postgres transactions to 3, on the pgbouncer
slots the `index.ts` comment says are already contended. `stores` has RLS disabled
(migration `20260609000000_complete_force_rls_coverage`, no later migration re-enables it; grepped
every migration), so the read needs no tenant GUC. All 9 call sites now `await storeTimeZone(id)`.
Pinned by `tests/unit/finance-tz-lookup-no-extra-tx.test.ts` (reintroducing the wrapper at any call
site reddens it). Cost if wrong: if RLS is ever re-enabled on `stores`, the bare read returns no row
and every report silently counts Egypt days; the guard to add then is a `stores` policy test.
