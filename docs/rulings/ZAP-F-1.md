# ZAP-F-1

> Section: 2026-10-01 — backlog batch z-ci-other (branch `fix/backlog-z-ci-other`)

**Ruling ZAP-F-1 — "no scan ran" is detected OUTSIDE the scan's run; the in-run `cancelled()`
branch stays but is no longer described as covering a queued cancel (issue 2289).**
`notify-failure` inside `zap-baseline.yml` only runs if it is dispatched and gets a runner. The
run history shows it IS evaluated after a zap-job timeout (runs 35967069299, 35829519117: notify
`skipped` under the old `failure()`-only condition, not dropped), but nothing in the run can report
a run cancelled before dispatch or a runner that never comes. `zap-freshness-check.yml` asks the
Actions API once a day whether any `zap-baseline` run on `main` concluded `success`/`failure` in
26h and alerts on Telegram when none did; it exits 2 (fails) when the API is unreadable and 0 when
`ZAP_TARGET` is unset (the scan is dormant by design). Verified live against the API on
2026-10-01 (fresh: run 36685419137 concluded failure). Its own concurrency group is keyed on the event (a dispatch cannot cancel the cron), and
its alert fires on `cancelled()` too, worded as UNKNOWN — as it is when the API is unreadable
(exit 2 → `state=unknown`), so a token failure never pages as "no scan ran" (PR 2333 audit). Residual: it rides the same self-hosted
runner (cloud minutes are billing-blocked), so a DOWN runner silences both — that is
`ci-runner-guard.sh` on the Mac. `railway-deploy.yml`'s `failure()`-only `notify-failure` is left as
is: a cancelled or never-run deploy there is already caught out-of-run by
`railway-deploy-drift-check.yml` (stalled-pipeline alert after 90 min). The claim that the in-run
branch fires for a concurrency-cancelled QUEUED run was not exercised (it would mean cancelling a
real nightly scan); the out-of-run check makes the answer not matter. Cost if wrong: one extra
Telegram message on a night the scan really did run late.
