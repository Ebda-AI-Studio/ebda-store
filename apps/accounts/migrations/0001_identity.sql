-- ebda-identity (Ruling ID-1/ID-2, ID-3): merchants, staff and super admins only (users.store_id IS NULL in the
-- Store database). User ids are the EXISTING Store User.id UUIDs. Time = ISO-8601 TEXT as exported by the
-- migration so rows copy byte-for-byte; enums = CHECK; booleans = 0/1; arrays/JSON = TEXT json.
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  first_name TEXT NOT NULL,
  last_name TEXT NOT NULL,
  phone TEXT,
  role TEXT NOT NULL CHECK (role IN ('customer','store_admin','super_admin','staff')),
  status TEXT NOT NULL CHECK (status IN ('active','inactive','suspended')),
  email_verified INTEGER NOT NULL DEFAULT 0,
  avatar TEXT,
  language TEXT NOT NULL DEFAULT 'en',
  last_login_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  mfa_enabled INTEGER NOT NULL DEFAULT 0,
  mfa_secret TEXT,
  mfa_backup_codes TEXT NOT NULL DEFAULT '[]',
  mfa_enrolled_at TEXT,
  token_version INTEGER NOT NULL DEFAULT 0
);
-- Admin emails are one global namespace, case-folded: the same rule as users_admin_email_key in the Store DB.
CREATE UNIQUE INDEX users_email_lower ON users (lower(email)) WHERE deleted_at IS NULL;

-- Sessions: one per login (sid). Revoking a session denies its access tokens at the next isRevoked check.
CREATE TABLE sessions (
  sid TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER,
  revoked_reason TEXT,
  ip TEXT,
  user_agent TEXT,
  amr TEXT NOT NULL DEFAULT 'pwd'
);
CREATE INDEX sessions_user ON sessions (user_id);

-- Refresh tokens: opaque 256-bit values, stored as sha256 hex, rotated on every refresh with reuse detection.
-- The legacy Store rows are copied here byte-for-byte (token = the legacy JWT string, never matched by a
-- new-format lookup), so nothing is lost; browsers re-login once because the cookie domain moves (Ruling ID-5).
CREATE TABLE refresh_tokens (
  id TEXT PRIMARY KEY,
  token TEXT NOT NULL UNIQUE,
  user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  sid TEXT REFERENCES sessions (sid) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  replaced_by_id TEXT,
  revoked_at TEXT,
  revoked_reason TEXT
);
CREATE INDEX refresh_tokens_user ON refresh_tokens (user_id);
CREATE INDEX refresh_tokens_sid ON refresh_tokens (sid);

-- One-time codes (OTP) and links: email verification, password reset. Code stored as sha256 hex.
CREATE TABLE verification_tokens (
  id TEXT PRIMARY KEY,
  token TEXT NOT NULL UNIQUE,
  user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN ('email','password_reset','two_factor')),
  expires_at TEXT NOT NULL,
  used_at TEXT,
  created_at TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX verification_tokens_user_type ON verification_tokens (user_id, type);

CREATE TABLE passkey_credentials (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  credential_id TEXT NOT NULL UNIQUE,
  public_key TEXT NOT NULL,
  counter INTEGER NOT NULL DEFAULT 0,
  transports TEXT NOT NULL DEFAULT '[]',
  device_type TEXT NOT NULL,
  backed_up INTEGER NOT NULL DEFAULT 0,
  rp_id TEXT NOT NULL,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_used_at TEXT
);
CREATE INDEX passkey_credentials_user ON passkey_credentials (user_id);

-- Short-lived challenges (passkey ceremonies, MFA step-up): consumed exactly once.
CREATE TABLE challenges (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  user_id TEXT,
  data TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX challenges_expires ON challenges (expires_at);

-- Login throttle: failed attempts per (key, window). key = 'e:<lower email>' or 'i:<ip>'.
CREATE TABLE login_attempts (
  key TEXT NOT NULL,
  at INTEGER NOT NULL
);
CREATE INDEX login_attempts_key_at ON login_attempts (key, at);
