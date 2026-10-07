-- Migration: enable_pg_stat_statements (index audit 2026-10, recommendation 1,
-- approved 2026-10-03). No table, column or data change.
--
-- Why: the 2026-10-01 audit had only table counters, so the `cart_items` and
-- `carts` sequential scans could not be attributed to a statement. With
-- pg_stat_statements every statement has calls, total/mean/max time, rows and
-- shared-buffer reads. How to read it: docs/DB-INDEX-MIGRATIONS.md
-- ("Reading pg_stat_statements").
--
-- Neon: pg_stat_statements 1.11 is available on the production compute
-- (pg_available_extensions) and is already in shared_preload_libraries
-- (checked read-only on 2026-10-03), so the statistics are collected as soon as
-- the extension exists. The migration role (neondb_owner, the DIRECT_URL role)
-- is a member of pg_read_all_stats, which is what lets it read other roles'
-- statement text. `pg_stat_statements.track` is `top` (client statements only).
-- Fresh Neon project / any non-superuser owner: pg_stat_statements is NOT a
-- "trusted" extension, so a plain owner role gets "permission denied to create
-- extension" (insufficient_privilege), and a server without contrib gets
-- undefined_file. Either one used to abort `migrate deploy` and wedge a new
-- database on this migration. The statement is observability only, so it is
-- guarded: on those errors it raises a NOTICE and the migration still succeeds
-- (enable it later: Neon console > Extensions, or `CREATE EXTENSION
-- pg_stat_statements;` as a privileged role). Any other error still fails loudly.
-- Self-hosted PG (CI service containers, local scratch DBs): CREATE EXTENSION
-- succeeds with contrib installed, but the view reads error until the server
-- preloads the library. That is harmless: nothing in the app reads the view.
--
-- Cost: one view and a few functions in `public`; the counters live in shared
-- memory (default 5,000 statements), no table is written. Statement text is
-- normalised (`$1`, `$2`), so bound values, including a customer's phone or
-- email, are not stored. Rollback: rollback.sql alongside this file.

DO $$
BEGIN
  CREATE EXTENSION IF NOT EXISTS pg_stat_statements;
EXCEPTION
  WHEN insufficient_privilege OR undefined_file OR feature_not_supported THEN
    RAISE NOTICE 'pg_stat_statements not enabled (%): %', SQLSTATE, SQLERRM;
END
$$;
