# R-EBDA-PRICING-6

> Section: 2026-10-07 — Locked pricing (R-EBDA-PRICING-\*)

Ruling R-EBDA-PRICING-6: store count is per owner, decided by the owner's best plan across live stores (a canceled one counts as `free`, 1 store). A second store (only reachable on a plan that allows it) is provisioned on the Business tier with no second Growth trial, to stop trial farming; multi-store billing coupling is built by EBDA-FUNNEL-13/-18 (the oldest store is the billing parent; children are included and never charged). `POST /stores` for a merchant's first store still creates a Basic `active` subscription with no checkout, as before. Evidence: `assertOwnerMayCreateStore`, `onboarding-create-store-plan.test.ts`. Cost if wrong: a lapsed Business owner's extra stores stay active until billing learns about parent/child; close with a billing follow-up before launch.
