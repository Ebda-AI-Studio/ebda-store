-- Make the WITH CHECK clause EXPLICIT on the accounting RLS policies.
--
-- These policies (accounts / journal_entries / journal_lines / sequences) were
-- created with only a USING(...) clause and no FOR/WITH CHECK. PostgreSQL
-- therefore already treats them as FOR ALL with WITH CHECK defaulting to the
-- USING expression — so INSERT/UPDATE writes ARE governed (and have worked
-- since the accounting feature shipped, via runInTenantContext's
-- app.current_store_id GUC or the app.bypass_rls escape hatch).
--
-- This migration is a NO-OP hardening: it states the INSERT/UPDATE check
-- explicitly, byte-identical to each policy's existing USING expression, so the
-- intent is unambiguous and static RLS audits stop reporting "RLS enabled but
-- no write policy". Behaviour is unchanged. ALTER POLICY ... WITH CHECK only
-- adds/sets the check clause; it does not drop or recreate the policy.

ALTER POLICY accounts_tenant_isolation ON "accounts"
  WITH CHECK (
    store_id::text = current_setting('app.current_store_id', true)
    OR current_setting('app.bypass_rls', true) = 'true'
  );

ALTER POLICY journal_entries_tenant_isolation ON "journal_entries"
  WITH CHECK (
    store_id::text = current_setting('app.current_store_id', true)
    OR current_setting('app.bypass_rls', true) = 'true'
  );

ALTER POLICY journal_lines_tenant_isolation ON "journal_lines"
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM journal_entries e
      WHERE e.id = journal_lines.entry_id
        AND (
          e.store_id::text = current_setting('app.current_store_id', true)
          OR current_setting('app.bypass_rls', true) = 'true'
        )
    )
  );

ALTER POLICY sequences_tenant_isolation ON "sequences"
  WITH CHECK (
    store_id::text = current_setting('app.current_store_id', true)
    OR current_setting('app.bypass_rls', true) = 'true'
  );
