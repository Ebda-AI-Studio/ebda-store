# AUI-3

> Section: 2026-09-30 — Admin UI: coupons chrome, feature-flag staleness, Customers page (branch `fix/admin-ui-coupons-features-customers`)

**Ruling AUI-3 — #2046, #2049, #2051 (duplicate / phantom / zero-spend rows in the aggregation) are
NOT fixed in this branch.** The KPI "Customers" count inherits them because it counts the same rows
the list shows; on a truncated store (>20k orders) every KPI is marked "Recent orders only" rather
than presented as complete. Those issues change the aggregation's keying, which is a separate,
larger change. Cost if wrong: a store with guest-then-registered shoppers shows a customer count a
few rows high until those issues land.
