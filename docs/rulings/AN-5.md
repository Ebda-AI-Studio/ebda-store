# AN-5

> Section: 2026-09-30 — Analytics batch 1 (branch `fix/analytics-batch-1`, PR #2220)

**Ruling AN-5 — `conversionRate` means ONE thing: orders per product view (the /analytics KPI,
ruling AP-8). The insights dashboard's orders÷carts figure is renamed `cartToOrderRate` and
labelled "Cart → order".** Merging main put two different rates under the same field name: the
analytics `conversionRate` (orders / product views, `conversionRateBasis:
'orders_per_product_view'`) and this branch's `yesterdayFunnel.conversionRate` (orders / carts
created). Both are useful and both come from `funnel_snapshots`, so neither was dropped; the
cart-based one takes the name `funnel-report.service.ts` already uses for it (`rates.cartToOrder`),
and the admin card label changes from "Conversion" to "Cart → order" / «من السلة إلى الطلب». The
analytics field keeps its name because the MCP `admin_get_dashboard` tool and swagger already
publish it. Asserted in `tests/unit/insights-routes-contract.test.ts` (the dashboard payload has
`cartToOrderRate` and no `conversionRate`). Cost if wrong: a merchant compares "Cart → order" on
Insights with "Conversion rate" from the API/MCP and still expects them to match — they measure
different denominators by design.
