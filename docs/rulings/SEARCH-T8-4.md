# SEARCH-T8-4

> Section: 2026-10-16 — Search program, PR 1 (P0): SEARCH-\*

Ruling SEARCH-T8-4 — the edit page's "Switch to AI" for search words runs inline in the request (the existing `/ai/reset-field` path) but still draws on the BULK quota, because the generator always asserts `bulk: true`. Evidence: one generator, one quota class, matching the brief; the click is rare. Cost if wrong: when the bulk share is exhausted for the day, the click returns an empty field (the quota error is logged and deferred) instead of drawing on the interactive reserve; the next sweep fills it.
