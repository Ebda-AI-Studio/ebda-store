# RFM-K3

> Section: 2026-09-30 — Merchant MCP read tools + RFM segment drill-down (branch `feat/mcp-read-tools-rfm-drilldown`)

**Ruling RFM-K3 — issue 2051 is fixed here (superseding AUI-3 for 2051 only).** The zero-order union
now excludes by real user ids, skips a user whose email/phone already keys a guest row, and is
skipped entirely on a truncated scan. 2046 and 2049 remain open. Cost if wrong: a registered
shopper with no orders and a contact matching an unrelated guest row is hidden from the list.
