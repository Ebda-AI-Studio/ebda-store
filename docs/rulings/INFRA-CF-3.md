# INFRA-CF-3

> Section: Lifecycle emails and referral attribution (2026-10-22, branch `feat/lifecycle-emails`)

Ruling INFRA-CF-3 (2026-10-24) - GO to Phase 1 of the Cloudflare-only migration. Evidence: Phase 0 gates 1 to 5 in `docs/plans/done/2026-10-24-cf-phase0-go-no-go.md` (production parity 7/7, cart add p50 5337 to 702 ms, products list p95 547 to 319 ms, restore drill 7/7 tables equal, about $15/month at 1,000 stores). Conditions: host-to-store resolution moves to the D1 directory first; order create is re-measured like-for-like before any money path moves; the Worker bundle budget is tracked. Cost if wrong: about two weeks of schema-port and repo-layer work, bounded because Postgres stays untouched until Phase 5.
