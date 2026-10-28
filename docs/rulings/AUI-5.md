# AUI-5

> Section: 2026-09-30 — Admin UI: coupons chrome, feature-flag staleness, Customers page (branch `fix/admin-ui-coupons-features-customers`)

**Ruling AUI-5 — the customers aggregation cache key moves to `customers-agg:v2:<storeId>`.** The
cached value gained `summary`; a v1 entry read after deploy would render an unknown KPI strip for up
to the 300s TTL. The version bump turns it into a clean miss. Cost if wrong: one extra aggregation
per store right after deploy.
