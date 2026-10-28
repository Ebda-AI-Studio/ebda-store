# AUI-4

> Section: 2026-09-30 — Admin UI: coupons chrome, feature-flag staleness, Customers page (branch `fix/admin-ui-coupons-features-customers`)

**Ruling AUI-4 — feature-flag freshness uses `refresh()` after every admin write path plus
focus/visibility revalidation; the optional socket push (`store.feature_toggled`) is not built.**
Every write path in the admin (FeatureMatrix toggle, reset, plan change; Settings plan change) now
refreshes the store-wide context, and a merchant in another tab or device picks the change up on the
next focus. Cost if wrong: a merchant who keeps the admin tab focused while a super-admin toggles a
feature elsewhere sees it only after switching tabs, navigating a full reload, or refocusing.
