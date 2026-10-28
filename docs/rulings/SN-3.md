# SN-3

> Section: 2026-09-25 — Sentry open-issues sweep (branch `fix/sentry-open-issues`)

**Ruling SN-3 — EBDA-API-29 (MyFatoorah `TimeoutError`) needs no code change.** The 8s
`AbortSignal.timeout` fired on `/v2/InitiatePayment`, i.e. before any invoice existed; the
`/payments/create` catch runs `rollbackForPaymentFailure` (order cancelled, inventory + cart restored,
idempotent), and the storefront shows its generic "try again" copy. 8s per call (16s worst case for
Initiate + Execute) is inside the checkout's patience. Cost if wrong: a timeout on
`ExecutePayment` after MyFatoorah minted the invoice leaves a payable invoice for a cancelled
order — the same window every provider timeout has, closed by the webhook/reconciler, not by a
shorter timeout. Observed, not changed: `CheckoutClient` clears the saved checkout form from
sessionStorage before it checks the payment result, so a reload after a failed payment loses the
typed form (in-page state survives, so an immediate retry does not).
