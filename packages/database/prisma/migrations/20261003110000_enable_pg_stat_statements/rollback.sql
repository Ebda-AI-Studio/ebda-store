-- Rollback for 20261003110000_enable_pg_stat_statements.
-- Drops the view and functions only; the accumulated statistics are lost, no
-- application data is touched. Run on the non-pooled DIRECT_URL.
DROP EXTENSION IF EXISTS pg_stat_statements;
