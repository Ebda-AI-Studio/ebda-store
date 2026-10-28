# R-EBDA-PRICING-4

> Section: 2026-10-07 — Locked pricing (R-EBDA-PRICING-\*)

Ruling R-EBDA-PRICING-4: "API / webhook access" is gated as the existing merchant-facing programmatic surface, the merchant-admin MCP (`merchant_mcp`: key issuance routes plus the MCP runtime), by the plan limit `apiAccess` (Business only). No merchant outbound-webhook system exists in the codebase, so there is nothing else to gate. Evidence: `rg webhook apps/api/src/routes` finds only inbound provider webhooks; `plan-gates.test.ts` feature map cases. Cost if wrong: if a merchant webhook feature is added later it must read `apiAccess` too, or it ships ungated. SUPERSEDED IN PART by R-EBDA-PRICING-5 (2026-10-14): the merchant-admin MCP is now Growth + Business and no longer follows `apiAccess`; `apiAccess` itself is unchanged.
