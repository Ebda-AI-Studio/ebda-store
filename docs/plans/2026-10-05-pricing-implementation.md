# Locked pricing implementation plan

**Goal:** Basic/Growth/Business prices and the Growth trial match Ahmad's locked decision.
**Architecture:** Add a forward catalog migration; keep historical migrations and legacy subscription codes intact. Publish the same monthly and annual prices on the bilingual marketing and help pages. Gate new orders after seven days over the monthly cap.
**Spec:** docs/plans/2026-10-05-pricing-decisions.md

- [x] Add priced paid catalog rows; hide historical Free/Pro from public selection, zero their fees, preserve existing subscription references.
- [x] Resolve locked catalog fallback values and create a fourteen-day Growth trial atomically during self-serve provisioning.
- [x] Gate both shopper and admin order creation after seven days over the current month's cap; expired trials cannot place orders.
- [x] Publish monthly/annual prices and bilingual billing copy.
- [ ] Run focused catalog, onboarding, order-limit and billing checks; sweep references and record remaining entitlement gaps.

Ruling R-EBDA-PRICING-1 — Keep historical free/pro/comped identifiers as hidden compatibility rows. Existing foreign keys reference these codes; deleting them would disrupt stores. Cost if wrong: hidden legacy rows need a later explicit subscription migration.

## Evidence and remaining work

21 focused unit/route tests pass. Shared, API and marketing typechecks pass after generating the local Prisma client. Database migration, billing integration and browser UAT have not been exercised. Store-count limits, plan-based branding removal, merchant API/webhook access and analytics/support tiers need implementation; the existing engine has no corresponding entitlement fields. No deployment was performed.
