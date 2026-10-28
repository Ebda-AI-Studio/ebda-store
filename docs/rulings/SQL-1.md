# SQL-1

> Section: 2026-09-30 — Merchant MCP read tools + RFM segment drill-down (branch `feat/mcp-read-tools-rfm-drilldown`)

**Ruling SQL-1 — `::uuid` casts against TEXT id columns removed in three raw queries, with a static
gate.** Every id/FK column here is TEXT, so `store_id = ${x}::uuid` is `text = uuid` and errors on
every call: the guest half of `GET /customers/search` and the barcode "order fully picked" check
were failing at runtime (reproduced on a migrated scratch Postgres; production not queried).
`tests/unit/raw-sql-no-uuid-cast-on-text-ids.test.ts` fails on the pattern. Cost if wrong: none
known — the casts could never have succeeded on this schema.
