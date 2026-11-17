-- SELF-SERVICE gap A7: the provider activation ledger is the `activation.*` rows of provider_verification_events
-- (activation.activated_self | activation.activated_admin | activation.deactivated; ref = the activation request id,
-- the actor is on the audit row with the same resource id). Those rows are APPEND-ONLY: a trigger refuses every
-- UPDATE and every DELETE of one. Other ops (real-use evidence) keep their old behaviour. Expand-only, no data change.
-- Rollback: DROP TRIGGER provider_activation_ledger_append_only ON provider_verification_events; DROP FUNCTION
-- provider_activation_ledger_append_only();

CREATE OR REPLACE FUNCTION provider_activation_ledger_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.op LIKE 'activation.%' THEN
    RAISE EXCEPTION 'provider_verification_events: activation ledger rows are append-only (% of %)', TG_OP, OLD.id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS provider_activation_ledger_append_only ON provider_verification_events;
CREATE TRIGGER provider_activation_ledger_append_only
  BEFORE UPDATE OR DELETE ON provider_verification_events
  FOR EACH ROW EXECUTE FUNCTION provider_activation_ledger_append_only();
