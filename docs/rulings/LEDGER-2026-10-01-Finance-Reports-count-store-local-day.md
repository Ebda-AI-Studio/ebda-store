# LEDGER-2026-10-01-Finance-Reports-count-store-local-day

> Section: 2026-10-01 — Finance Reports count store-local days (`fix/finance-reports-store-tz`)

Ruling LEDGER-2026-10-01-Finance-Reports-count-store-local-day — unlabelled notes from the legacy ledger section "2026-10-01 — Finance Reports count store-local days (`fix/finance-reports-store-tz`)":

Context: Ruling RF-1 left the finance GL reports on whole-UTC-day periods and asked the owner to
decide. Owner decision (Ahmad, 2026-10-01): Finance Reports count days in the store's local time
zone, the same as the finance dashboard. Prod evidence (read-only, 2026-10-01): 8 of 122 journal
entries (demo-store 7, wady-aljuz 1) were posted between 00:00 and 03:00 Egypt time and move to the next
day; 0 cross a month or year boundary and 0 move Tax Payable (2100), so no filed month's
P&L or tax total changes today. All 3 prod stores have `timezone = 'Asia/Egypt'`.
