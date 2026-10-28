# MCP-R5

> Section: 2026-09-30 — Merchant MCP read tools + RFM segment drill-down (branch `feat/mcp-read-tools-rfm-drilldown`)

**Ruling MCP-R5 — guest customers are referenced by `GUEST:<sha256(key)>`, never by their email or
phone; a contact-less guest row (`guest:<orderId>`) is listable but has no profile.** Resolved only
against the calling store's aggregation, so a foreign or invented ref is a tool error. Cost if
wrong: an agent holding a contact-less guest's ref gets a summary and must use `admin_get_order`.
