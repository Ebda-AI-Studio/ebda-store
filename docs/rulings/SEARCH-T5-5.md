# SEARCH-T5-5

> Section: 2026-10-16 — Search program, PR 1 (P0): SEARCH-\*

Ruling SEARCH-T5-5 — `recordSearch` wraps the statement in `withSavepoint` and logs only `{ storeId, code }` (never the term or the error message, which can echo values); it fails open and returns false. Evidence: a failed log write must neither abort the shopper's read transaction nor leak the term into logs. Cost if wrong: a failed write drops one count.
