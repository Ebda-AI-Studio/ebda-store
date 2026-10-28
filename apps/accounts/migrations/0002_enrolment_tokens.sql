-- One-time first-factor enrolment tokens for platform administrators (Ruling ID-15). Issued only by the operator-run
-- scripts/upsert-super-admin.mjs, printed once to the operator's terminal, stored as sha256 hex. Single use, short TTL.
CREATE TABLE enrolment_tokens (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at INTEGER NOT NULL,
  used_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX enrolment_tokens_user ON enrolment_tokens (user_id);
