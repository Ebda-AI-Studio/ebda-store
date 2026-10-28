# PAY-ORPH-1b

> Section: Backlog batch followups (2026-10-01, branch `fix/backlog-followups`)

**Ruling PAY-ORPH-1b — the orphaned-invoice page is dispatched, not awaited (issue 2379).** The
`record` site runs inside the request's tenant transaction, already aborted by the failed write, and
awaiting `sendAlert` (Redis lock + Telegram POST capped at 5s) pinned that pooled connection for the
whole send, once per failed checkout, during the DB incident that produces the failure.
`alertOrphanedProviderInvoice` now writes its error log line (the durable record) synchronously and
dispatches the page in the background with its own catch, for all three call sites. Deliberately not
`deferAfterTenantCommit({ runOnRollback: true })`: `runOneDeferredTask` runs each task inside a
FRESH `runInTenantContext` transaction (maxWait 10s), so the page would wait on a pooled connection
from the database that just failed and hold it for the POST; `sendAlert` touches no database, so a
detached promise is safe. The per-order title stays (per-incident, like the unbooked-refund alert).
Pinned by `tests/unit/orphaned-invoice-alert.test.ts` (mutation-proven). Cost if wrong: a process
that exits within the ~5s send window loses that page — the error log line still names the provider
and transaction id. **Superseded in part (issue 2387):** `sendAlert` now tracks every send in
flight and `gracefulShutdown` awaits them (`awaitInFlightAlerts(6000)`, after `awaitDeferredWork`,
before `redis.disconnect()`), so a SIGTERM no longer drops this page or any other detached
`void sendAlert(...)`. Residual: a hard kill (SIGKILL, OOM, the 30s force-exit timer) still loses an
in-flight page; the error log line remains the record. **Amended (issue 2393):** the "5s-capped
POST" did not cap the whole send — the abort timer was cleared before a non-2xx's error body was
read, so a stalled body hung the send forever and the in-flight set held it (and its `opts`) for
the life of the process, eating the full drain on every SIGTERM. The abort now stays armed through
the body read, and `sendAlert` races every send against a hard `ALERT_SEND_DEADLINE_MS` (6s, lock +
POST + body) that resolves it `failed`, logs, and drops it from the set. The drain uses that same
constant, so every send tracked at SIGTERM has settled or been abandoned when it returns
(`tests/unit/alerts.test.ts`, both halves mutation-proven).
