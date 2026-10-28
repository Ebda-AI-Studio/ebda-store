# SEARCH-T3-7

> Section: 2026-10-16 — Search program, PR 1 (P0): SEARCH-\*

Ruling SEARCH-T3-7 — no explicit `ESCAPE '\'` on the LIKE arms. Evidence: Postgres's default escape is already `\`, `escapeLike` escapes backslash first-class along with `%` and `_`, patterns are bound values, and `LIKE p ESCAPE e` parses as `~~ like_escape(p, e)`, which was not planner-tested against the trigram indexes. Cost if wrong: none functionally; less self-documenting SQL.
