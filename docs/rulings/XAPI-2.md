# XAPI-2

> Section: Backlog batch x-api (2026-10-01, branch `fix/backlog-x-api`)

**Ruling XAPI-2 — a process killed between the denial row's insert and its pointer publish still
suppresses that window's count for up to 45s (issue 2330, accepted residual).** The fix releases
the `pending` reservation whenever the publish FAILS, so a Redis error falls back to per-attempt
rows. A process terminated between the insert and the publish (a deploy mid-flood) cannot run that
release; the reservation then expires on its own TTL (`DENIAL_ROW_PENDING_TTL_SECONDS`, 45s — kept
longer than the insert's 40s transaction envelope so a slow insert cannot lose its slot). A shorter
"stale pending" takeover was declined: under a flood with a contended pool it would make every
repeat open its own tenant transaction, the DoS surface the coalescing exists to close. Cost if
wrong: one flood window reads `count: 1` for ≤45s if the API is killed at that exact moment.

**Owner decisions of 2026-10-01 (Ahmad: "do what you recommend"), implemented in this batch.**
