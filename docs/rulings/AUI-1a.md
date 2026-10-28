# AUI-1a

> Section: Backlog batch x-api (2026-10-01, branch `fix/backlog-x-api`)

**Ruling AUI-1a — revenue excludes FAILED payments; unpaid COD still counts (issue 2235; amends
AUI-1).** The dashboard (`getPeriodStats`, profit, sales series, top products, top categories, top
customers) and the Customers KPI strip (`countsTowardSpend`) move together, as AUI-1 requires.
`getRevenueByPaymentStatus` is deliberately unchanged: it is a breakdown BY payment status and
must keep its failed bucket. The KPI copy says so (EN + AR); `customers-agg` is bumped to `v4`.
Cost if wrong: a store whose gateway marks recoverable declines as `failed` sees them leave
revenue until they are retried and paid.
