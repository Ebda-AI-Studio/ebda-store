# R2-VIS-1

> Section: 2026-10-01 — backlog batch z-ci-other (branch `fix/backlog-z-ci-other`)

**Ruling R2-VIS-1 — the RLS-visibility guard is required before any BULK R2 delete and any orphan
REPORT, not before the per-URL `deleteR2ObjectIfOrphan` check (issue 2288).**
`assertStrictTablesVisible` moved to `apps/api/src/lib/r2-references.ts`; it now ANALYZEs a STRICT
table that reads 0 rows before trusting the catalog, treats `reltuples = -1` (never analyzed — a
fresh branch/restore, or a small table below autovacuum's threshold) as UNKNOWN and refuses, and
also counts `n_live_tup`. Measured on Postgres 16: a new table with 3 rows reads `reltuples -1,
n_live_tup 0` — the old `GREATEST(reltuples, 0)` passed it — and `3` after `ANALYZE`. Both bulk
collectors run it: `scripts/r2-orphan-audit.ts` before the report is printed (dry run too), and the
`r2-orphan-sweep` Inngest cron, which refuses to delete and marks its Telegram report "NOT
TRUSTWORTHY" (P1) on failure. The per-URL check in `r2-cleanup.service.ts` runs one indexed probe
per deleted file under `withRlsBypass` (pinned by defence `r2-cleanup-isstillreferenced-rls-bypass`);
adding four `count(*)` + possible `ANALYZE`s to every single-file delete is disproportionate, and a
wrong bypass there is already a mutation-gated defect. ~~Not verified: the guard end-to-end under a
role actually subject to RLS~~ — now verified by `tests/integration/r2-strict-visibility-guard.test.ts`
(issue 2354, see R2-VIS-2). Cost if wrong: one still-referenced file deleted by a per-URL cleanup if
the bypass itself is ever broken.
