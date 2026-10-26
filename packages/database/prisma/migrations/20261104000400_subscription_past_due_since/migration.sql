-- Ruling WA-GRACE-1: when did this subscription first go past_due? `store.plan_changed` carries it as
-- `pastDueSince` so Ebda WhatsApp ends its grace at min(periodEnd, pastDueSince + 7 d).
--
-- Maintained by a trigger, not by each service: EVERY write path (renewal failure, InstaPay due day,
-- admin override, a future one) is covered, and a path cannot forget to set or clear it. It is set
-- ONCE on the transition into past_due (a later failed retry does not move it) and cleared on any
-- other status.
ALTER TABLE "store_subscriptions" ADD COLUMN "past_due_since" TIMESTAMPTZ(3);

CREATE OR REPLACE FUNCTION store_subscriptions_track_past_due() RETURNS trigger AS $$
BEGIN
  IF NEW.status = 'past_due' THEN
    IF TG_OP = 'INSERT' THEN
      NEW.past_due_since := COALESCE(NEW.past_due_since, now());
    ELSIF OLD.status = 'past_due' AND OLD.past_due_since IS NOT NULL THEN
      NEW.past_due_since := OLD.past_due_since; -- already past_due: the first failure date stands
    ELSE
      NEW.past_due_since := COALESCE(NEW.past_due_since, now());
    END IF;
  ELSE
    NEW.past_due_since := NULL;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER store_subscriptions_past_due_since
  BEFORE INSERT OR UPDATE OF status, past_due_since ON "store_subscriptions"
  FOR EACH ROW EXECUTE FUNCTION store_subscriptions_track_past_due();

-- Rows already past_due: the best known start is their last update (the first failed renewal is not
-- recorded anywhere else). Conservative for WhatsApp: it can only make the grace end sooner than the
-- true first failure if the row was touched since, never later.
UPDATE "store_subscriptions" SET "past_due_since" = "updated_at" WHERE "status" = 'past_due';
