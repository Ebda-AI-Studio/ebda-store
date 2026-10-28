# SN-4

> Section: 2026-09-25 — Sentry open-issues sweep (branch `fix/sentry-open-issues`)

**Ruling SN-4 — FeatureService retries a connection-level DB failure once and otherwise fails
closed; no stale-map fallback.** The map gates paid features; serving a remembered map could say ON
for a feature a super-admin just turned off. Cost if wrong: two consecutive Neon connection failures
still 500 `/public/store/resolve` for that request.
