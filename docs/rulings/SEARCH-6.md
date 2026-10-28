# SEARCH-6

> Section: 2026-10-16 — Search program, PR 1 (P0): SEARCH-\*

Ruling SEARCH-6 — Typeahead stays lexical-only and is not logged. Evidence: latency, and logging keystrokes would pollute the log with prefixes. Cost if wrong: a dialect-only term finds nothing in the dropdown until Enter (the full search page has the vector leg).
