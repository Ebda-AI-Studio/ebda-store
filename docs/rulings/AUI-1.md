# AUI-1

> Section: 2026-09-30 — Admin UI: coupons chrome, feature-flag staleness, Customers page (branch `fix/admin-ui-coupons-features-customers`)

**Ruling AUI-1 — the Customers KPI "Total spent" / "Avg order value" / "Repeat rate" count orders
with `status NOT IN ('cancelled','refunded')`; the table's per-row "Total spent" keeps its existing
all-status sum.** The KPI population is the same one the dashboard's revenue uses
(`analytics.service.ts` `getPeriodStats`), so the two pages cannot disagree about what "spent"
means; the KPI card says "All orders except cancelled and refunded — paid or not" (issue 2235: the
earlier "Excludes cancelled and refunded orders" implied collected money, but a `pending` or
`failed`-payment order is counted; whether the population should exclude unpaid/failed payments,
here AND in `getPeriodStats`, is an open owner question on issue 2235). The row column was not changed
because it also feeds the detail page and the export, and changing its meaning is a separate
decision. Cost if wrong: on a store with cancelled orders the KPI total is lower than the sum of the
row column, which the card label explains but a merchant may still question.
