# RF-2

> Section: 2026-10-01 — Report filters apply (`fix/report-filters-apply`)

**Ruling RF-2 — the expenses date filter stays whole UTC days (now with an explicit `Z`).**
`expenseDate` is a calendar date (the form posts `YYYY-MM-DD`, stored as that day's UTC midnight),
so a viewer-local instant range would drop the first day for any viewer west of UTC. The old parse
depended on the server's TZ; the explicit `Z` removes that. Cost if wrong: an OCR draft whose
fallback `expenseDate` is `now()` after 21:00 UTC lists under the next Egypt day's neighbour.
