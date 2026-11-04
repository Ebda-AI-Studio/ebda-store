# NZ-D23

> Section: NEON-ZERO final removal, lite scope (2026-11-05)

**Ruling NZ-D23 - the API Worker has no Postgres: the HYPERDRIVE binding is gone, the Worker's Prisma client fails loud
(`POSTGRES_REMOVED`), a `pg` directory row answers 410, and the deploy no longer migrates or smoke-tests against Postgres.**
N-17 (lite): (1) `HYPERDRIVE` is removed from `apps/api/wrangler.jsonc`, `CfBindings`, `scripts/ebda-cf-api-config.mjs` (only
`EBDA_KV_CACHE_ID` and the D1 id are substituted), `cf-api-deploy.yml` (no `EBDA_HYPERDRIVE_ID`, no Postgres service, no
`prisma migrate deploy` step, no `EBDA_MIGRATE_DATABASE_URL`) and the workers-test config. (2) `withWorkerContext` runs every
fetch / queue / scheduled invocation inside `runWithRequestDb(createPostgresRemovedClient(...))`: any Prisma model, raw or
transaction call throws `PostgresRemovedError` (code `POSTGRES_REMOVED`) at once instead of opening a socket; the first one per
isolate is logged, sent to Sentry and raises a P1 alert (`api.worker.postgres_removed`). Node, tests and local dev keep the
real client. The isolate pool, `/__dev/probe`, `/__dev/stats` and `db-scope.test.ts` went with it. (3) `backendFor` throws
410 `STORE_STORAGE_REMOVED` for a `pg` row on a Worker (only the soft-deleted QA store has one). N-14b (`backendFor` as a
constant) is NOT done here: the D1 read is also the store-exists / soft-delete gate and Node still resolves `pg`; it moves
with the pg branches in N-16. (4) `/health` reports `postgres: "removed"`; the super-admin deep check reports
`database: removed` on a Worker and counts it healthy. (5) `pg-migration-drift.yml` (+ script and test) is deleted: nothing is
left to drift. `db-backup.yml` is NOT edited here: it keeps dumping Neon until the project is deleted, then is disabled (runbook
`neon-decommission.md`). Evidence: `tests/unit/postgres-removed.test.ts`, `store-backend-pg-gone.test.ts`; `SWEEP_STRICT=1`
route sweep + `pg-unreachable.test.ts` on the built Worker with NO hyperdrive binding (only the two OneSignal device routes
still answer 500, with `POSTGRES_REMOVED` in the log: the fix is a separate PR); `scripts/ci/workerd-smoke.sh` on local workerd:
`/health` 200, a `pg` directory row 410, unknown store 404, unknown route 404. This PR merges only AFTER the production cutover
(copy scripts and markers) is verified. Cost if wrong: a Postgres path the sweep missed answers 500 (and pages P1) instead of
hanging, and the rollback is a revert of this PR plus re-creating the Hyperdrive config while the Neon project still exists.
