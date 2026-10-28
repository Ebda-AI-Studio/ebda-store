# CI-CRON-1

> Section: 2026-10-03 — scoped-audit follow-ups (branch `fix/backlog-followups11`, issues 2427, 2429-2432, 2434)

## Ruling CI-CRON-1 — scheduled runs stay on self-hosted; push/PR/dispatch on cloud (2026-10-03)

Decision: `USE_SELF_HOSTED=false` (cloud) for push, PR and dispatch; every `schedule:` run stays on self-hosted unless `vars.SCHEDULED_ON_CLOUD == 'true'`. Owner instruction ("make the crons use only umbra").
Evidence: cloud bills each job at a 1-minute floor; the drift check (every 30 min), hourly railway probe and 2-hourly watchdog come to ~2,500 min/month before nightlies, against the plan's included minutes. The audit on #2453 (P0) showed a hard pin would make crons un-movable during a runner outage, so the pin has its own switch, and `workflow-runner-selector.test.ts` asserts every schedule-triggered job reads it (mutation-checked: reverting db-backup.yml reddens it).
Cost if wrong: during a runner outage, crons (incl. daily db-backup and both drift monitors) queue silently until someone flips `SCHEDULED_ON_CLOUD=true`; the runbook's outage section documents the flip.
