# Ruling NZ-TEARDOWN-DIAG-1 - bounded, diagnosing teardown for the orders contract suite

**Date:** 2026-11-05

**Decision:** `tests/integration/repo-factory-orders-contract.test.ts` ends with a teardown that, after 8 s, logs the pool counters and the live `pg_stat_activity` rows, ends any backend left `idle in transaction`, and bounds `ownerPg.end()` / `prisma.$disconnect()` at 20 s each with a logged message.

**Evidence:** on hosted CI (PR 437 runs 42051542716, 42056044397, 42067641601) every test passed (2597) but the file's `afterAll` hung. Run 42067641601's diagnostics named the cause: a backend `idle in transaction` on `BEGIN`, left when Prisma's driver adapter failed `startTransaction` with "Unknown transaction status" inside `noteOrderCreated` (plan-limit.service.ts, a logged and swallowed side effect) during the concurrent-submit case. Locally the teardown takes 0-2 ms and the failure does not reproduce. The path is Node/Postgres only; the Worker has no Postgres client after PR 437.

**Cost if wrong:** a genuine connection leak in Node-only code is ended in teardown instead of failing the suite; the 8 s diagnostic line in the CI log is the signal to read, and the adapter defect (a failed `startTransaction` must not leave `BEGIN` open) stays a tracked follow-up.

**Update 2026-11-05 (cause fixed):** the cause is Prisma 6.19.3's TransactionManager, not pg: `$disconnect()` -> `cancelAllTransactions()` flips a still-"waiting" start to "closing", `startTransaction` then resolves (BEGIN sent, connection checked out) and throws "Unknown transaction status." without ever calling commit/rollback on the adapter transaction. `packages/database/src/orphan-tx-guard.ts` (wired in `createPrismaClient`, Node path) now rolls back and releases any adapter transaction Prisma never closes (on dispose, and by a 40 s watchdog); test `packages/database/src/__tests__/orphan-tx-guard.test.ts` reproduces the race with a real PrismaClient over a fake adapter. The bounded teardown above stays as a safety net and should no longer fire; an 8 s diagnostic line in CI now means a NEW leak.
