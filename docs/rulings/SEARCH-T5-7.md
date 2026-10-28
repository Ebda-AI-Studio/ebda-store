# SEARCH-T5-7

> Section: 2026-10-16 — Search program, PR 1 (P0): SEARCH-\*

Ruling SEARCH-T5-7 — the query scrubber (`@ebda/shared` `sentry-url-scrub`) redacts values by KEY (`search`, `q`, `query`, `term`, `keyword(s)`, `email`, `phone`), not by value shape; a value stops at a DOUBLE quote (never an apostrophe: `encodeURIComponent` leaves `'` raw and Franco-Arabic terms use it as a letter, `3'`/`7'`) so a PostHog `$elements_chain` href is scrubbed too; an array key (`q[]`, `q%5B%5D`, `q[0]`) counts as its base key. Evidence: cheap, total for those params, leaves page/sort/ids readable. Cost if wrong: free text in an unlisted param name still reaches Sentry/PostHog; adding the name to `SENSITIVE_QUERY_PARAMS` fixes it everywhere.
