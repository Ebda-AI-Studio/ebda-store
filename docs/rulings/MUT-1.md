# MUT-1

> Section: 2026-09-30 — Merchant MCP read tools + RFM segment drill-down (branch `feat/mcp-read-tools-rfm-drilldown`)

**Ruling MUT-1 — the `storeId` filter on the batched shipments read in `admin_list_orders` survives
mutation and is kept.** Its `orderId IN (...)` comes from an already store-scoped page and order ids
are globally unique, so removing `storeId` changes no observable result (an equivalent mutant). It
stays as defence in depth. Cost if wrong: none; it is one indexed predicate.
