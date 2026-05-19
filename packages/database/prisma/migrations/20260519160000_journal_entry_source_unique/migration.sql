-- Idempotency at the database layer: at most one posted journal entry per
-- (store_id, source, source_id) tuple, when source_id is non-null. Manual
-- adjusting entries (no sourceId) are still allowed in any number.
--
-- Partial unique index because Postgres treats NULL as distinct in standard
-- unique indexes — without the WHERE clause, two manual entries with NULL
-- source_id would still be unique to each other (Postgres NULL semantics)
-- but adding WHERE makes the intent explicit and matches FWB's existing
-- partial-unique pattern (e.g. users_admin_email_key).

CREATE UNIQUE INDEX IF NOT EXISTS "journal_entries_store_source_source_id_unique"
  ON "journal_entries" (store_id, source, source_id)
  WHERE source_id IS NOT NULL;
