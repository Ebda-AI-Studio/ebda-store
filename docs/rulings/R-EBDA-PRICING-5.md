# R-EBDA-PRICING-5

> Section: 2026-10-07 — Locked pricing (R-EBDA-PRICING-\*)

Ruling R-EBDA-PRICING-5: analytics tiers map onto the existing insights routes: `standard` = insights dashboard and product velocity, `advanced` = cohorts, funnel, segments and RFM; the `/analytics/*` routes are the `basic` tier and stay open. Support tier (email / chat / priority) is a stored label shown to ops, not code-enforceable. The decision doc names the tiers but not the report split, so the split is mine. Evidence: `requireAnalyticsTier` on `insights.routes.ts`, `plan-gates.test.ts`. Cost if wrong: a Basic merchant loses a report Ahmad meant to include; move the one `requireAnalyticsTier` argument.

---

> Section: 2026-10-14 — Security batch (branch `fix/security-batch-2026-10-14`, audit: `docs/security/audit-2026-10-14.md`)

Ruling R-EBDA-PRICING-5 — Ahmad decided 2026-10-14 to OPEN the merchant-admin MCP to Growth: Growth and Business both get key minting, all read tools and all write tools (supersedes the "Business only" part of R-EBDA-PRICING-4; `apiAccess` stays Business-only and reserved for any future API/webhook access). It is decoupled from `apiAccess` by `planIncludesMerchantMcp` in `@ebda/shared` (plan codes growth + business, or any plan with `apiAccess`) feeding `merchant_mcp` and `merchant_mcp_write` in `FeatureService.rowsToMap`, rather than widening `apiAccess`, because widening needs a data change to the live `plans` rows (the locked_pricing migration is pinned equal to the seeds by `locked-pricing.test.ts`) and would give Growth an entitlement nobody decided. Write tools stay behind scope, RBAC, the confirm round-trip, fail-closed audit and the merchant switch `store.settings.mcpWriteEnabled` (apps/api/src/mcp/merchant-write.ts). Evidence: tests/unit/plan-gates.test.ts, locked-pricing.test.ts, signup-funnel.test.ts, merchant-write-gate.test.ts, locked-pricing-catalog.test.ts (written, not run at authoring). Cost if wrong: Growth merchants (EGP 3,490) get a surface priced as Business (EGP 9,990), so some Business upgrades are lost and the AI-assistant support load now lands on Growth.
