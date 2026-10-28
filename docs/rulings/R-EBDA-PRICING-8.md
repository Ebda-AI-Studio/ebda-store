# R-EBDA-PRICING-8

> Section: 2026-10-07 — Locked pricing (R-EBDA-PRICING-\*)

Ruling R-EBDA-PRICING-8: `founding_free` is created hidden (unlimited, 0 fee, branding removable, API on) and is an admin-granted class with `comped`: never purchasable, never charged, always status `comped`. Nothing is assigned to it; Amelia stays on `comped` until Ahmad says move her. Evidence: `GRANTED_PLAN_CODES` in `billing/period.ts`, `subscription-billing.test.ts`. Cost if wrong: a billing path that only checks `comped` would charge a founding store, so any new billing path must call `isGrantedPlan`.
