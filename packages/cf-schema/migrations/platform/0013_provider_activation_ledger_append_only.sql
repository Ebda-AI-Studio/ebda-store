-- Hand-written. The provider activation ledger is the `activation.*` rows of provider_verification_events (the Postgres
-- twin is migration 20261117000100_provider_activation_ledger_append_only). A row of that kind can never be changed or
-- removed: it carries the "blocked by admin" flag (newest row = activation.deactivated) and the activation history.
-- Other ops (real-use evidence) are untouched, so a running release is never rejected. Idempotent.
CREATE TRIGGER IF NOT EXISTS "provider_activation_ledger_no_update"
BEFORE UPDATE ON "provider_verification_events"
WHEN OLD."op" LIKE 'activation.%'
BEGIN
  SELECT RAISE(ABORT, 'provider_verification_events: activation ledger rows are append-only');
END;

CREATE TRIGGER IF NOT EXISTS "provider_activation_ledger_no_delete"
BEFORE DELETE ON "provider_verification_events"
WHEN OLD."op" LIKE 'activation.%'
BEGIN
  SELECT RAISE(ABORT, 'provider_verification_events: activation ledger rows are append-only');
END;
