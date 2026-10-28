# RFM-K2

> Section: 2026-09-30 — Merchant MCP read tools + RFM segment drill-down (branch `feat/mcp-read-tools-rfm-drilldown`)

**Ruling RFM-K2 — the stale-row sweep does not run when a store has zero paid orders.** The early
return is unchanged, so a store whose every paid order was later refunded keeps its last snapshots.
Cost if wrong: such a store's Segments page shows customers who no longer qualify, until it has a
paid order again.
