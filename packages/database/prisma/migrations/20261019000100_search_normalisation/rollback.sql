-- rollback.sql for 20261019000100_search_normalisation.
-- Run on DIRECT_URL in psql autocommit (no BEGIN). Roll the CODE back first: it is what queries
-- these indexes. The column and the three functions are kept (no data loss; search_terms may
-- already hold merchant/AI text). Dropping an index loses no data; the normalised searches go
-- back to sequential scans.
DROP INDEX CONCURRENTLY IF EXISTS "products_search_doc_trgm_idx";
DROP INDEX CONCURRENTLY IF EXISTS "products_name_doc_trgm_idx";
