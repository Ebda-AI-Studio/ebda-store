# NZ-D21

> Section: NEON store delete / erasure safety (2026-11-04)

**Ruling NZ-D21 - for a Durable Object store the entitlement fields (plan, billing suspension,
status, deletion) are written to Postgres by every writer that writes them to D1, and the
reconciler stops comparing what it cannot source.** `storeUpdateOnDo` (so `StoreService.setStatus`
and every `updateStoreThrough` call) and the compare-and-set `storeUpdateMany` wrote D1 + the DO
only, leaving Postgres stale; `syncStoreEntitlement` (after any deferred plan / billing write) and
the hourly reconciler then copied or acted on that stale Postgres value, so a later billing write
could re-activate a super-admin suspension and the reconciler could re-close a reactivated store.
Both now call `mirrorEntitlementToPg` first (Postgres, only those five fields, a failure changes
nothing), so the copy-back sources the value just written; the deferred paths already wrote
Postgres. The reconciler also (a) no longer compares or reads domains for a DO store (they live in
D1 only; it raised a permanent alert-only per store per hour and one `withStore` transaction per
store) and (b) `closeDoRow` keeps the stricter of the Postgres and D1 status, so a deleted-but-
`active` Postgres row cannot loosen a suspended D1 row. Prod measure: 6 of 7 stores in D1
`ebda-platform` are `storage_backend='do'` (read-only SELECT, 2026-11-04). Evidence:
`tests/unit/store-update-on-do.test.ts` and `store-directory-d1-sync.test.ts` (each new test fails
before the fix). Residual: domain comparison for the remaining Postgres stores still reads one
store per transaction, sequentially (a single batched read needs a new SECURITY DEFINER function
and migration); Postgres-then-D1 is not atomic, and a D1 failure after the Postgres write leaves
Postgres ahead, which the reconciler repairs fail-closed. Cost if wrong: a Postgres outage now
blocks a DO store's status or plan change (503) instead of silently succeeding with stale data.
