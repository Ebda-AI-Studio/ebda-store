# MCP-R3

> Section: 2026-09-30 — Merchant MCP read tools + RFM segment drill-down (branch `feat/mcp-read-tools-rfm-drilldown`)

**Ruling MCP-R3 — no payouts/settlements tool, and no `admin_list_payments` in this batch.** No
settlement model exists. Exposing `payments` as "collections" is cheap to build but has no dashboard
surface to be a façade over, so it would be the one tool with its own query and its own definition
of a collection; it waits for a settlement import to give it a real shape. Cost if wrong: a merchant
asking "what did MyFatoorah pay me" gets "not available" rather than a per-order payments list.
