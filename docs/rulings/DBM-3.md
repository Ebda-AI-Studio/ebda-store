# DBM-3

> Section: 2026-10-03 — DB maintenance (pg_stat_statements + redundant prefix indexes)

**Ruling DBM-3 — `pg_stat_statements` is enabled by a migration, not by hand.** Neon already
preloads the library and offers version 1.11, and the migration role is in `pg_read_all_stats`, so
`CREATE EXTENSION IF NOT EXISTS` is the whole change. Cost if wrong: nothing to undo beyond a view
and a few functions (`rollback.sql` drops the extension and the accumulated counters).
