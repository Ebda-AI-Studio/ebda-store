-- Add SMS marketing opt-in consent column to orders table.
--
-- Captures the customer's explicit consent (ticked checkbox at checkout) to
-- receive PROMOTIONAL SMS messages. Defaults to false — customers are never
-- opted in silently. The notification dispatcher already blocks SMS when this
-- is false for promotional events; transactional notifications (shipped,
-- delivered, cancelled, refunded) are unaffected.
--
-- Additive / safe: the DEFAULT false means every existing order row is treated
-- as no-consent-given, which is the correct conservative interpretation.

ALTER TABLE "orders" ADD COLUMN "sms_opt_in" BOOLEAN NOT NULL DEFAULT false;
