-- Integrator clients (identity contract v1.3): a merchant's SERVER obtains short access tokens with client_credentials.
-- One generic table; v1.3 ships audience = whatsapp only. A client belongs to ONE store and ONE audience, fixed at creation.
CREATE TABLE clients (
  id          TEXT PRIMARY KEY,            -- cli_<26 chars>, public; also the token's sub and sid
  store_id    TEXT NOT NULL,
  audience    TEXT NOT NULL,
  name        TEXT NOT NULL,
  scopes      TEXT NOT NULL,               -- space separated, validated against the per-audience registry
  created_by  TEXT NOT NULL,               -- the owner who created it (kept when ownership changes)
  created_at  INTEGER NOT NULL,
  revoked_at  INTEGER
);
CREATE INDEX clients_store ON clients (store_id);

-- At most two live secrets per client (a rotation overlap). Only HMAC-SHA256(pepper, secret) is stored.
CREATE TABLE client_secrets (
  client_id   TEXT NOT NULL REFERENCES clients (id) ON DELETE CASCADE,
  slot        INTEGER NOT NULL CHECK (slot IN (1, 2)),
  hmac        TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER,                     -- NULL = no expiry; set on the OLD secret by a rotation
  PRIMARY KEY (client_id, slot)
);

-- Append-only trail. Lifecycle rows (created, rotated, revoked, auth_failed) live as long as the store;
-- `issued` rows are pruned after 90 days by the hourly cron.
CREATE TABLE client_audit (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id    TEXT NOT NULL,
  store_id     TEXT NOT NULL,
  event        TEXT NOT NULL CHECK (event IN ('created','rotated','revoked','issued','auth_failed')),
  at           INTEGER NOT NULL,
  actor        TEXT,                       -- the owner user id for lifecycle events
  jti          TEXT,
  secret_slot  INTEGER,
  ip_prefix    TEXT,
  scope        TEXT
);
CREATE INDEX client_audit_client_at ON client_audit (client_id, at);
CREATE INDEX client_audit_event_at ON client_audit (event, at);
CREATE INDEX client_audit_store ON client_audit (store_id);
