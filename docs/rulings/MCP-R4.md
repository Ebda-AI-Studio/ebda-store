# MCP-R4

> Section: 2026-09-30 — Merchant MCP read tools + RFM segment drill-down (branch `feat/mcp-read-tools-rfm-drilldown`)

**Ruling MCP-R4 — delivery `slot` is always `null`, `method` is the booked-shipment carrier or `null`,
and the zone is reported as the address's area/governorate.** Checkout captures no slot and no
delivery method, and the matched `ShippingZone` is not stored on the order; resolving it after the
fact would be a guess once zones are edited. Cost if wrong: an agent sees `method: null` on most
orders (0 shipments exist in prod per the audit) and must read `deliveryNote`.
