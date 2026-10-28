# R-EBDA-PRICING-2

> Section: 2026-10-07 — Locked pricing (R-EBDA-PRICING-\*)

Ruling R-EBDA-PRICING-2: "Powered by Ebda" is removed on Growth and Business only, as the decision doc's entitlement table says (Basic: yes, Growth/Business: off). The decision is the plan limit `brandingRemoval`, resolved server-side into the `remove_branding` feature and shipped in `enabledFeatures`; it covers the storefront footer and customer emails (transactional, newsletter, campaign). The suspended-store maintenance page keeps the attribution because it is platform-operated. A super-admin StoreFeature override still wins. Evidence: `tests/unit/plan-gates.test.ts`, `tests/unit/branding-removal.test.tsx`. Cost if wrong: a Basic merchant could expect an email footer removal we did not sell, or a Growth merchant sees the line on the maintenance page.
