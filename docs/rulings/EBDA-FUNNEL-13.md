# EBDA-FUNNEL-13

> Section: 2026-10-07 — Signup funnel: plan choice, card on file or InstaPay, 14-day Growth trial (branch `feat/signup-funnel`, stacks on #10)

Ruling EBDA-FUNNEL-13 — Store allowance = the OLDEST live store's plan `maxStores` (the billing parent; R-EBDA-PRICING-6), for creation (`assertOwnerMayCreateStore`), go-live and suspension. This replaces "best plan across the owner's stores", which let a child store's own Business row keep granting stores after the parent lapsed. After any plan change (`assignPlan`, a renewal or checkout success, a downgrade or dunning lapse, a manual payment), `reconcileStoreAccess` suspends LIVE stores beyond the allowance (oldest kept) and restores those back within it. Cost if wrong: an owner whose FIRST store is not the one they pay Business on is capped at the first store's plan (a super-admin re-assigns plans to fix it).
