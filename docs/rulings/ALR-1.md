# ALR-1

> Section: Backlog batch followups (2026-10-01, branch `fix/backlog-followups`)

**Ruling ALR-1 — the alert throttle fails open on a throw, locally (issue 2384).** `sendAlert`
wraps `redis.acquireLock` and treats a throw (Redis connected but rejecting writes) as "slot
acquired", so the `unreadable_lost` and orphaned-invoice P1s are delivered in the Redis state that
raises them, and `sendAlert` keeps its "never throws" contract for every awaiting caller. The fix is
NOT in `acquireLock`: its other callers (cron leader locks, bulk sweeps) need fail-closed — failing
open there means two concurrent runs. Cost if wrong: during a Redis write fault, a flapping alert is
not deduplicated and can repeat once per event until Redis recovers.
