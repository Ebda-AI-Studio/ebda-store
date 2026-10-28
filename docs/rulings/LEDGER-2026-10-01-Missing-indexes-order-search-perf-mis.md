# LEDGER-2026-10-01-Missing-indexes-order-search-perf-mis

> Section: 2026-10-01 — Missing indexes / order search (`perf/missing-indexes`, issue #2405)

Ruling LEDGER-2026-10-01-Missing-indexes-order-search-perf-mis — unlabelled notes from the legacy ledger section "2026-10-01 — Missing indexes / order search (`perf/missing-indexes`, issue #2405)":

Evidence: production `pg_stat_user_tables` / `pg_stat_user_indexes` / `pg_constraint` (read-only,
2026-10-01) plus EXPLAIN ANALYZE on a scratch DB at 50k orders/store. Detail:
`docs/perf/index-audit-2026-10.md`.
