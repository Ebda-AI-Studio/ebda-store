-- 20261124100000_legal_evidence_no_user_fk (Ruling NZ-N27B)
--   legal_acceptances / legal_notice_deliveries kept a FOREIGN KEY to users ON DELETE CASCADE, so deleting a user deleted
--   the consent proof with them. Erasure now pseudonymises user_id (an opaque `erased:<uuid>`) and keeps the row, which a FK
--   to users cannot hold. Dropping the constraint is the whole change; no data moves. The D1 platform schema never had it.
ALTER TABLE "legal_acceptances" DROP CONSTRAINT IF EXISTS "legal_acceptances_user_id_fkey";
ALTER TABLE "legal_notice_deliveries" DROP CONSTRAINT IF EXISTS "legal_notice_deliveries_user_id_fkey";
