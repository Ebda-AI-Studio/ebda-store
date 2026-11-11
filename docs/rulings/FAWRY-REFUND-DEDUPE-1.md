# FAWRY-REFUND-DEDUPE-1

> Section: 2026-11-12 (follow-up to #626 / PR #682)

**Ruling FAWRY-REFUND-DEDUPE-1 - a repeated Fawry refund notice that carries no
`paymentRefrenceNumber` is still acknowledged (so Fawry does not retry forever), but never
silently: the webhook route raises a store-scoped P1 (`payment.webhook.fawry_refund_repeat`).**
Fawry does not sign the refund amount. After #682 the dedupe key is ref + status + signed
amount + reference number, so if Fawry sends a second partial refund with the original amount
and no reference number, it is byte-for-byte the same signed data as the first. **Residual:**
such a second refund is not booked automatically. **Manual check (in the alert):** open the
order's Fawry transaction in the Fawry dashboard, compare its refunds with the order's payment
(`refunded_amount` and the payment timeline), and record any missing refund by hand. Paymob and
Kashier refunds are their own transactions with their own ids, so a repeat there is a real
redelivery and raises nothing. Evidence: `tests/unit/fawry-refund-repeat-ambiguous.test.ts`.
Cost if wrong: an alert per genuine redelivery of a reference-less Fawry refund notice (noise,
throttled by the alert key), versus a refund that is never booked.
