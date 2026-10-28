# FRT-1

> Section: 2026-10-01 — Finance Reports count store-local days (`fix/finance-reports-store-tz`)

**Ruling FRT-1 — replaces RF-1. P&L, trial balance, balance sheet and tax report (JSON, XLSX, and the
admin's CSV built from the JSON) resolve a `YYYY-MM-DD` bound as that calendar day in the store's
time zone (`stores.timezone`), via the shared report-range helpers (`zonedDayStart`/`zonedDayEnd`/
`zonedIsoDay` in `@ebda/shared`, `storeTimeZone()` in `apps/api/src/lib/report-range.ts`).** Tax
rows are dated in the same zone, export filenames and Filters sheets name the same days, and the
admin's default pickers ("today", "first of month") are the store's today, not the UTC day. A full
ISO instant (what the finance dashboard sends) is still used as-is; the dashboard's no-param
default window is now the store's current month instead of the server's. The server's own TZ no
longer matters (the old date-only parse was server-local). Pinned by
`tests/integration/finance-reports-store-tz.test.ts` (6 mutants, all killed). Cost if wrong: a
period filed under UTC days before this change will not reproduce to the fils if re-run for a month
whose boundary had a 00:00–03:00 Egypt posting — none exists in prod today.
