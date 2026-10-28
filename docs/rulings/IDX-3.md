# IDX-3

> Section: 2026-10-01 — Missing indexes / order search (`perf/missing-indexes`, issue #2405)

**Ruling IDX-3 — unused and redundant indexes are listed, not dropped.** There are 37 left-prefix
duplicate btrees and 7 zero-scan non-unique indexes on tables of 300 or more rows. The audit gives
a verdict for each. A drop needs its own migration and lock plan (`docs/DB-INDEX-MIGRATIONS.md`),
and was out of scope for the owner's request. Cost if wrong: a few hundred kB of indexes and their
write amplification remain until a follow-up drops them.
