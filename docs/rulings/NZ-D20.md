# NZ-D20

> Section: NEON store delete / erasure safety (2026-11-04)

**Ruling NZ-D20 - merchant erasure is all-or-nothing across a merchant's stores, and a closed
store's `mutate` answers 410.** `storeDoSurface.eraseSubject` now reads every store's money gate
first (`StoreDO.moneyInFlight`, read-only) and refuses the whole erasure if any store has money in
flight; only then does it erase each store, so a clean store A is never anonymised and sealed while
B refuses and the job halts before identity, media and customer intelligence (NZ-D17 promise held;
re-erasing a sealed store stays a no-op). `StoreDO.mutate` returned `STORE_CLOSED` without
`status`, so `r.status ?? 502` callers saw a 502; it now carries `status: 410` like the stock, money
and record paths (the other producers already did; the 423 on the cutover `__import/__unseal` surface
is deliberate). The anonymise plan writes one `erased:<id>` token into NOT NULL columns, which would
fail on a UNIQUE column; checked against `packages/cf-schema/migrations/store/*.sql`: no plan
column is UNIQUE or in a unique index (the unique tables key on `store_id`, one row per store DO), so
no change. Evidence: `apps/api/workers-do/erasure.test.ts` (two stores, B paid-undelivered, A stays
open) and `mutate.test.ts` (410). Cost if wrong: a payment landing on B between the preflight and
its own gate still refuses B after A is sealed, and a future UNIQUE on a plan column would roll the
erasure back loudly instead of silently.
