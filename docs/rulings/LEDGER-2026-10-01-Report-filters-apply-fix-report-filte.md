# LEDGER-2026-10-01-Report-filters-apply-fix-report-filte

> Section: 2026-10-01 — Report filters apply (`fix/report-filters-apply`)

Ruling LEDGER-2026-10-01-Report-filters-apply-fix-report-filte — unlabelled notes from the legacy ledger section "2026-10-01 — Report filters apply (`fix/report-filters-apply`)":

Context: owner report 2026-09-30 "for the sales reports, why does the selected filter not apply?",
then an orders export that held the whole store history (138 orders, every status, every date)
while the list was filtered. Every admin report/list surface with a filter was traced UI → params →
route → service → query; the shared contract is `@ebda/shared` `report-range` + `list-filters`.
