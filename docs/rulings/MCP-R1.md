# MCP-R1

> Section: 2026-09-30 — Merchant MCP read tools + RFM segment drill-down (branch `feat/mcp-read-tools-rfm-drilldown`)

**Ruling MCP-R1 — the funnel follows owner ruling AUD-2: a stage the platform cannot capture for
guest shoppers is `null` with a reason, never 0.** `checkoutsStarted` and `ordersAbandoned` come from
`abandoned_carts`, which guest carts never produce. The AUD-2 text itself was not found in this repo
or the two audit documents; it is applied as the brief stated it. Cost if wrong: an agent that
expected a number gets `null` and must read `unavailable`, which the tool description tells it to.
