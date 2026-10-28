# SEARCH-1

> Section: 2026-10-16 — Search program, PR 1 (P0): SEARCH-\*

Ruling SEARCH-1 — Lexical search runs on trigram GIN _expression_ indexes over an IMMUTABLE normaliser, not a generated column. Evidence: Prisma would read a generated column on every product select, and P1 would need a table rewrite to change it, whereas an expression index adds nothing to row payloads. Cost if wrong: every query must repeat the exact function call to hit the index; a hand-written variant silently seq-scans (pinned by the EXPLAIN test in Task 2).
