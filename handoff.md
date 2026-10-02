# Handoff — finance reports count store-local days (owner decision 2026-10-01)

_Updated 2026-10-01. Branch `fix/finance-reports-store-tz`, worktree
`_worktrees/force-website-builder__fix-finance-reports-store-tz`, off `origin/main` @ 26eae23c
(#2398 merged there while this was in progress; rebased onto it)._

## Goal

Finance Reports (P&L, trial balance, balance sheet, tax report and their XLSX/CSV exports) count
days in the store's time zone (Kuwait, UTC+3), like the finance dashboard — not UTC midnight.
Replaces Ruling RF-1 (from #2398) with FRT-1; FRT-2 = fall back to Asia/Kuwait.

## Current state

Code, tests, docs and rulings written; see the PR for the gate results. Not deployed.

## Done

- `@force/shared` report-range: `DEFAULT_STORE_TIME_ZONE`, `resolveStoreTimeZone`,
  `zonedDayStart`/`zonedDayEnd`/`zonedIsoDay`/`zonedMonthStartDay`.
- API: `storeTimeZone()` (`lib/report-range.ts`); `parseFinanceDate` takes the store zone; the tax
  report routes resolve days in it; tax rows dated in it; export filenames/Filters in it; dashboard
  no-param default = store's month.
- Admin Reports page: default pickers in the store's zone; "Days are counted in …" note (en + ar).
- Tests: `tests/integration/finance-reports-store-tz.test.ts` (6/6 mutants killed), unit updates.
- Docs: `docs/RULINGS.md` (RF-1 replaced, FRT-1/FRT-2), `docs/uat/tax-reports.md`,
  `docs/business/02-feature-catalog.md`.
- Prod evidence (read-only): 8 of 122 journal entries in the 00:00–03:00 Kuwait window move a day;
  0 move month; 0 are tax-moving.

## In progress

Nothing.

## Left to do

- After this PR merges + deploys: `/health` commit == main, then open Finance → Reports on
  prod for pecannbee, pick a day that holds one of the 8 moved entries, and check it lands on the
  Kuwait day (read-only).
