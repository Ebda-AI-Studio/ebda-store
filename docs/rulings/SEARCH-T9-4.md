# SEARCH-T9-4

> Section: 2026-10-15 — Phase B1 Qamar (B1-\*)

Ruling SEARCH-T9-4 — the CI/compose/harness Postgres major equals production's: 17. Evidence: production `server_version_num` 170011 with pg_stat_statements 1.11 (coordinator, measured 2026-10-16); the whole migration chain, the new table's test and the ebda_app RLS proof pass on `pgvector/pgvector:0.8.0-pg17` (reviewer and task-9 round 1). PG17 runs index/ANALYZE/REINDEX maintenance with `search_path = pg_catalog, pg_temp` and renamed pg_stat_statements columns, so a pg16 CI would pass migrations that fail the production `migrate deploy` (P3009, every later API deploy blocked). Cost if wrong: none; when production moves major, bump the pinned tag in the parity test and every file it reads.
