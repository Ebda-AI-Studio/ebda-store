# FAWRY-REFUND-DEDUPE-1

> Section: 2026-11-12 (follow-up to #626 / PR #682)

**Ruling FAWRY-REFUND-DEDUPE-1 - EVERY repeated Fawry refund notice (with or without a
`paymentRefrenceNumber`) is still acknowledged (so Fawry does not retry forever), but never
silently: the webhook route raises a store-scoped P1 (`payment.webhook.fawry_refund_repeat`).**
Fawry does not sign the refund amount. After #682 the dedupe key is ref + status + signed
amount + reference number, so if Fawry sends a second partial refund with the original amount
and the same (or no) reference number, it is byte-for-byte the same signed data as the first; nothing
in Fawry's documentation proves the reference number changes per refund, so the alert does
not depend on it. **Residual:**
such a second refund is not booked automatically. **Manual check (in the alert):** open the
order's Fawry transaction in the Fawry dashboard, compare its refunds with the order's payment
(`refunded_amount` and the payment timeline), and record any missing refund by hand. Paymob and
Kashier refunds are their own transactions with their own ids, so a repeat there is a real
redelivery and raises nothing. Evidence: `tests/unit/fawry-refund-repeat-ambiguous.test.ts` and
the signed-route cases in `tests/unit/inbound-payment-webhook-routes.test.ts`.
Cost if wrong: an alert per genuine redelivery of any Fawry refund notice (noise,
throttled by the alert key), versus a refund that is never booked.
