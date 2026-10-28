# ADM-LOAD-1

> Section: Backlog batch followups (2026-10-01, branch `fix/backlog-followups`)

**Ruling ADM-LOAD-1 — the three super-admin ops lists read apiGet's error channel; the rest of the
admin is a recorded residual (issue 2375).** `apiGet` never throws — a 403, a 500 or an unreachable
API resolves as `{ data: null, error }` — so a `try/catch` around it is dead code and an outage
renders as the page's empty state. On `/email-queue`, `/sms-queue` and `/webhook-events` the empty
state is an operational claim ("No failed emails"), so they now show a `role="alert"` load-failure
state instead. About 70 other admin call sites destructure only `data` (`grep -rn "const { data } =
await apiGet" apps/admin/src`); most render a generic empty list, not a claim that nothing failed,
so they were not changed in this batch. Cost if wrong: an outage on one of those pages reads as
"no rows" until someone refreshes.
