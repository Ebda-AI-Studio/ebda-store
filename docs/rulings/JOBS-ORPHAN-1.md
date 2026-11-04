# JOBS-ORPHAN-1

> Section: 2026-11-04 - branch `fix/jobs-orphan-queued`

**Ruling JOBS-ORPHAN-1 - queue-then-send fails fast on Cloudflare: a job row whose start event cannot start is
marked failed at once, a dispatch that starts nothing throws inside the Worker, and the hourly watcher
re-dispatches a stale `queued` row once then fails it with a single alert.**
Evidence: prod `bulk_ai_jobs` row 97c155b3-cbae-4ccb-afd6-9d19a0092448 (kind `recommendations`, system-initiated, created
2026-11-02 14:43Z) sat `queued` for ~44 h. `enqueueRecommendationsSweepNow` only logged a failed `inngest.send`, and
`lib/jobs/dispatch.ts` returned silently when an event had no bound runner, so nothing ever failed the row. The watcher
paged hourly with Inngest advice (re-PUT `/api/v1/inngest`, a 404 since #294). Changes: (1) shared
`lib/jobs/enqueue-fail.ts` (`markJobFailedOnEnqueueError`, used by ai.routes, ai-autofill and both `bulkImportJob`
enqueues in bulk.routes; catalog-import already failed its own job); (2) `dispatchEvents` throws, logging job and event
name, when the Worker has bindings but an event has no subscriber or no runner (Node without bindings stays a no-op by
design); (3) `queue-depth-watch` re-dispatches a stale `queued` row once via `RESUME_EVENT_BY_KIND` (counted in
`auto_resume_count`), then marks it failed with `error_message = 'never started'` and alerts once; alert copy now points
to JOBS_WORKFLOW / JOBS_QUEUE and the job id, and the alert source label is `jobs.queue-depth` (label only; no monitor
keys on the old string). The existing stuck row is handled by the watcher after deploy (no production write).
Residual: a `queued` row that was auto-resumed from running (count already >= 1) is failed, not re-sent, at its next stale
tick. Cost if wrong: a legitimately slow-to-start job older than 30 min is failed 'never started' and the merchant retries it.
