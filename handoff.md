# Handoff — report filters apply (owner report 2026-09-30)

_Updated 2026-10-01. Branch `fix/report-filters-apply`, worktree
`_worktrees/force-website-builder__fix-report-filters-apply`, off `origin/main` @ 2aefa901._

## Goal

"For the sales reports, why does the selected filter not apply?" — treated as a defect class: every
admin report/list surface with a filter, traced UI → params → route → service → query, fixed at the
root with ONE shared contract (`@force/shared` `report-range` + `list-filters`). Follow-up from the
owner: the orders export held the whole history — every export must be exactly the filtered list,
name the range in its filename, and carry a "Filters" sheet.

## Current state

Code, tests, docs and rulings written; typecheck, lint (0 errors), format, unit + colocated
(6867/6868, the 1 = a supertest HTTP parse flake in an unrelated coupon-validate test, green alone),
the two new integration files + 8 related ones on the scratch DB, and RLS payload parity (198
comparisons, PASS) all green locally. 12/12 mutants killed. One PR. Not deployed.

## Done

- Shared contract: `reportRangeParams` / `parseReportRange` (both-or-neither, 422 on half/garbage),
  `orderListFilterParams` / `parseOrderListFilters`, `customerListFilterParams`, `localDayRange`,
  `exportFilename`, `describeListFilters`; API `lib/report-range.ts` (`rangeOrLegacyDays`),
  `lib/exports/xlsx.ts` (`addFiltersSheet`).
- Orders: list search server-side (was page-only), range in viewer-local days, unknown status 422,
  export = `OrderService.listWhere` (same filters) + range filename + Filters sheet; CORS exposes
  Content-Disposition; stock-scan order lookup takes the exact order-number match.
- Customers export: same search/segment as the list (Customers + Purchases + Summary sheets).
- Finance: XLSX filenames `_to_` / `as-of`, Filters sheet, day named in the server-local TZ it was
  parsed in; CSV gets a Filters row; exports disabled while a new range loads; latest-request-wins.
- Expenses: `hasOcr` read (dashboard card), `?status=` deep link + status select, explicit-UTC days.
- Analytics: all routes on the shared parser, latest-request-wins, non-period cards labelled en+ar.
- Payment abandonments, loyalty, stock adjustments, Orders PWA: shared range; coupons status filter
  (stale closure) fixed; finance dashboard stale guard + labels.
- Rulings RF-1..RF-5 in `docs/RULINGS.md`; merchant doc `docs/merchant/orders.md`.

## In progress

Nothing.

## Left to do

- Owner decision (Ruling RF-1): move finance GL reports to Kuwait-local day boundaries?
- After merge + deploy: verify `/health` commit, then export orders for a narrow range on prod and
  check the file's Filters sheet + row count (read-only).
