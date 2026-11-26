-- Widen the admin_audit event list with the self-service credential event (A23): a user regenerating their own MFA recovery codes.
-- SQLite cannot alter a CHECK, so the table is rebuilt (rows, ids and the index are preserved). No code or hash is ever stored.
CREATE TABLE admin_audit_new (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  event    TEXT NOT NULL CHECK (event IN ('super_admin_bootstrapped','super_admin_enrolment_token_issued','mfa_recovery_codes_regenerated')),
  user_id  TEXT NOT NULL,
  email    TEXT NOT NULL,
  actor    TEXT NOT NULL,              -- who ran it: the operator script user, or 'self' for a self-service change
  at       INTEGER NOT NULL,           -- epoch ms
  detail   TEXT                        -- small JSON
);
INSERT INTO admin_audit_new (id, event, user_id, email, actor, at, detail) SELECT id, event, user_id, email, actor, at, detail FROM admin_audit;
DROP TABLE admin_audit;
ALTER TABLE admin_audit_new RENAME TO admin_audit;
CREATE INDEX admin_audit_user_at ON admin_audit (user_id, at);
