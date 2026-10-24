-- Migration: staff_invites (Ruling ID-13).
-- One row per staff invitation sent to an address that already has an account. The signed link carries the row id (jti) and
-- is honoured only while the row is pending and unexpired; accepting flips it in the same transaction that creates the
-- store_staff row, so a link works once. Additive: a new table, no existing row touched. FK: store delete CASCADEs it.
-- Rollback: DROP TABLE staff_invites (outstanding links then fail closed: INVITE_INVALID).
CREATE TABLE "staff_invites" (
  "id" TEXT NOT NULL,
  "store_id" TEXT NOT NULL,
  "email" TEXT NOT NULL,
  "role" TEXT NOT NULL DEFAULT 'staff',
  "status" TEXT NOT NULL DEFAULT 'pending',
  "invited_by" TEXT,
  "accepted_by" TEXT,
  "expires_at" TIMESTAMPTZ(3) NOT NULL,
  "decided_at" TIMESTAMPTZ(3),
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "staff_invites_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "staff_invites_role_check" CHECK ("role" IN ('staff')),
  CONSTRAINT "staff_invites_status_check" CHECK ("status" IN ('pending', 'accepted', 'revoked', 'expired'))
);
CREATE INDEX "staff_invites_store_id_status_idx" ON "staff_invites"("store_id", "status");
CREATE INDEX "staff_invites_store_id_email_idx" ON "staff_invites"("store_id", "email");
ALTER TABLE "staff_invites" ADD CONSTRAINT "staff_invites_store_id_fkey"
  FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE staff_invites ENABLE ROW LEVEL SECURITY;
ALTER TABLE staff_invites FORCE ROW LEVEL SECURITY;
CREATE POLICY ebda_tenant_isolation ON staff_invites AS PERMISSIVE FOR ALL TO ebda_app
  USING (store_id = nullif(current_setting('app.current_store_id', true), ''))
  WITH CHECK (store_id = nullif(current_setting('app.current_store_id', true), ''));
