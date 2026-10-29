# Background jobs on the store Durable Object, and the write freeze (INFRA-CF-1 PR E, Rulings CF-JOBS-1, CF-JOBS-2)

Code: `apps/api/src/lib/jobs/{do-guard,job-data,store-db,freeze}.ts`, `apps/api/src/cf/queue-freeze.ts`, `packages/database/src/job-store-guard.ts`. Tests: `tests/unit/jobs-do-guard.test.ts`, `tests/unit/jobs-freeze.test.ts`, `apps/api/workers-test/store-schedule.test.ts`.

## Which jobs can serve a DO store

`JOBS_ON_DO=1` + a store in `STORE_DO_ENABLED_IDS` = a DO store for jobs. With `JOBS_ON_DO` unset nothing below applies (every store on Postgres, today).

| Class (`job-data.ts`) | Jobs                                                                                                                                   | On a DO store                                                                                                             |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `none`                | `heartbeat`, `gmail-alert-poller`, `alerts-failure-watch`, `audit-log-archive-weekly`, `billing-renewal-daily` (platform tables, logs) | runs unchanged                                                                                                            |
| `ported`              | `wholesale-pending-nudge-cron` (reads through `withStoreDb`)                                                                           | runs, via the store's alarm, reading its DO                                                                               |
| `unported` (default)  | every other job (`prisma`/`withStore`, row locks, raw SQL, money and stock models)                                                     | **refused**: no handler call, no `onFailure`, alert P0 (`MONEY_JOBS`: payments, refunds, orders, accounting, stock) or P1 |

How a run is decided: the store is the alarm's store or `event.data.storeId`. Sweeps (crons, no store) run for Postgres stores only: inside a guarded run `storeDirectory` / `acrossStores` drop DO stores and an `unported` sweep alerts which ones it skipped.

To port a job: replace `prisma`/`withStore` reads and writes with `withStoreDb(storeId, db => ...)` (reads) / `storeWriter` (non-money writes, `docs/cf/repo-factory.md`), move its id from the default into `PORTED_JOBS`, and the unit test checks the source no longer touches `prisma`. Money and stock jobs wait for D2a/D2b.

## Alarms

Armed for DO stores only (`syncStoreSchedules`, hourly). A Postgres store keeps the global Cron Trigger. `JOBS_CF_ALARMS=all` is therefore safe to leave on.

## Write freeze (`WRITES_FROZEN=1`)

| Writer                                                  | While frozen                                                                               | After the thaw                       |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------ | ------------------------------------ |
| HTTP                                                    | 503 `READ_ONLY_WINDOW` (middleware/write-freeze.ts)                                        | normal                               |
| Cron Trigger, sweep (fires again within 6 h)            | tick skipped                                                                               | the next tick does the work          |
| Cron Trigger, rarer job; legacy daily crons             | job started and parked / queued as `legacy-cron`                                           | runs once                            |
| Queue consumers (email, sms, jobs, CI, WhatsApp events) | each message re-sent with a 300 s delay, acked only after the re-send                      | consumed normally                    |
| DLQs, and queues this Worker does not produce to        | retried with a backoff (5 min doubling to 12 h)                                            | consumed normally                    |
| Workflow instance                                       | sleeps 5 min at a time before its first step and before every later step (leases released) | continues at its next step           |
| StoreSchedule alarm                                     | due time kept, re-armed 5 min out, no attempt spent                                        | same occurrence (same event id) runs |

Limits: a step already executing when the flag lands finishes; a freeze over 24 h aborts a parked Workflow loudly and lets the platform retry/DLQ path alert; an alarm frozen over 24 h skips the stale occurrence.
