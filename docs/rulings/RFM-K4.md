# RFM-K4

> Section: 2026-09-30 — Merchant MCP read tools + RFM segment drill-down (branch `feat/mcp-read-tools-rfm-drilldown`)

**Ruling RFM-K4 — the customer detail route resolves a guest key the way the list groups it.** A
guest key now matches guest checkouts (no `customer_id`) whose LOWERCASED email is the key, or — for
an order with no email — whose phone is the key. The old exact-case JSON match 404'd any guest who
typed a capital letter, and pulled signed-in orders sharing the email into a guest profile. Cost if
wrong: a merchant who relied on a guest profile also showing that person's signed-in orders now
sees them only on the registered row.
