# PREMIUM-40

> Section: 2026-11-03 - Storefront premium defaults (PREMIUM-\*)

Ruling PREMIUM-40 - audit re-check against main after #393: the controls the audit still measured under 44px (Dahab cart-drawer steppers 36px, Dahab PDP stepper 36px wide on phones, Dahab slide dots 36px wide, the legacy cart remove button 32px, products list-row compare/CTA 40px) are 44px targets; `templates/shared/tap-targets.guard.test.ts` pins them. Cost if wrong: a slightly roomier stepper/dot row on a phone.
