-- One refund claim, one settlement outcome (money-integrity, refund reconciliation).
--
-- A refund claim (payment_events.event_type = 'refund_initiated', details.claimId) ends in AT MOST ONE of:
--   * 'refund_webhook_absorbed'  a settle webhook was reconciled with it (it stands, the money left), or
--   * 'refund_failed'            the provider refused and the claimed amount was given back.
-- The two are mutually exclusive and neither may repeat. settleRefund takes the payment row lock (FOR UPDATE) before it
-- decides, so this index is the belt to that braces: a second writer for the same claim fails with a unique violation
-- instead of double-consuming the claim or releasing money a webhook already reported as sent.
-- Additive, partial, built on existing rows (only claim-keyed refund events carry details.claimId).
CREATE UNIQUE INDEX IF NOT EXISTS "payment_events_claim_single_outcome_key"
  ON "payment_events" ((("details" ->> 'claimId')))
  WHERE "event_type" IN ('refund_webhook_absorbed', 'refund_failed');
