# EC-9

> Section: 2026-09-25

**Ruling EC-9 — super-admin still bypasses the feature gate.** `requireFeature` lets `super_admin`
through on every feature by design (`middleware/feature-gate.ts`). A super-admin can therefore
create and send a campaign for a store whose feature is off — but only by explicitly creating and
sending one. Cost if wrong: platform staff can send on a merchant's behalf without the merchant
having enabled the feature.
