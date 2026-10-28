# AN-7

> Section: 2026-09-30 — Analytics batch 1 (branch `fix/analytics-batch-1`, PR #2220)

**Ruling AN-7 — one unknown-state pattern across the analytics surfaces: never a 0 for a figure we
cannot compute. A KPI card shows the word "Unknown" plus a one-line reason (and a fix link where one
exists); a dense table cell or a rate shows "—" with the reason next to it.** Main's profit card
(`AnalyticsStatsGrid`: "Unknown" + "cost price missing on N items" + "Add cost prices") is the card
form; this branch's insights rates/products "—" and dead-stock "Unknown (no cost price)" are the
table form. The GL Gross-profit card (`GlKpiCards`, AP-11's open residual) joins the card form: when
the period has GL revenue but zero COGS it shows "Unknown" with "no cost of goods was booked" instead
of repeating revenue. Residual: GL Net income is still shown when COGS is 0 (other expenses make it a
real, if COGS-less, figure). Cost if wrong: a store that genuinely sells zero-cost goods (services,
digital) sees "Unknown" gross profit where revenue would have been correct.
