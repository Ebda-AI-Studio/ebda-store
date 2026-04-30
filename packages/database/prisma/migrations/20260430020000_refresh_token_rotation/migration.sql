-- Refresh-token reuse detection (T1-3).
--
-- Previously the refresh handler deleted the old row on rotate, so a
-- stolen refresh token replayed after the legitimate user already
-- refreshed produced a generic 401 — we never noticed the compromise.
--
-- This migration adds three fields so we can keep the row after rotate
-- and detect replay:
--   replaced_by_id  — id of the token that superseded this one (set on rotate)
--   revoked_at      — timestamp of revoke (rotate, logout, password change, reuse-detect)
--   revoked_reason  — short tag used in audit logs / debugging
--
-- The auth service treats any presentation of a row with revoked_at NOT NULL
-- as a reuse signal and revokes EVERY token for that user.
ALTER TABLE "refresh_tokens"
  ADD COLUMN IF NOT EXISTS "replaced_by_id" TEXT,
  ADD COLUMN IF NOT EXISTS "revoked_at" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "revoked_reason" TEXT;

CREATE INDEX IF NOT EXISTS "refresh_tokens_revoked_at_idx"
  ON "refresh_tokens"("revoked_at");
