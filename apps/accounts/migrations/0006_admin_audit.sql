-- Audit trail for platform-administrator lifecycle events written by the operator scripts (Ruling ID-20).
-- One row per event; never updated, never deleted by application code. No credential, hash or token is ever stored here.
CREATE TABLE admin_audit (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  event    TEXT NOT NULL CHECK (event IN ('super_admin_bootstrapped','super_admin_enrolment_token_issued')),
  user_id  TEXT NOT NULL,
  email    TEXT NOT NULL,
  actor    TEXT NOT NULL,              -- who ran the script (git user.email, else the OS user name)
  at       INTEGER NOT NULL,           -- epoch ms
  detail   TEXT                        -- small JSON: flags used (e.g. {"allowAdditional":true})
);
CREATE INDEX admin_audit_user_at ON admin_audit (user_id, at);
