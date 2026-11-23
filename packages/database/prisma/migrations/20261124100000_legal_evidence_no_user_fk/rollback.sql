-- rollback.sql for 20261124100000_legal_evidence_no_user_fk. Run on DIRECT_URL, AFTER rolling the code back, then:
--   DELETE FROM _prisma_migrations WHERE migration_name = '20261124100000_legal_evidence_no_user_fk';
-- Re-adding the FK FAILS while any row holds a pseudonymised user_id (`erased:...`); delete those rows first (they are the
-- erased users' consent evidence: export them before).
ALTER TABLE "legal_acceptances" ADD CONSTRAINT "legal_acceptances_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "legal_notice_deliveries" ADD CONSTRAINT "legal_notice_deliveries_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
