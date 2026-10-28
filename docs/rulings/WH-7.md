# WH-7

> Section: 2026-10-15 — Phase B1 Qamar (B1-\*)

Ruling WH-7 (2026-10-21, review M10) — customer erasure and webhook payloads. A delivery to an endpoint with `includeCustomer` on holds the shopper's name, email and phone in the stored payload. On erasure (`AuthService.eraseAccount`) `redactWebhookCustomerData` removes `data.customer` from every stored delivery of this store that belongs to the shopper's orders or carries their email, in the same transaction and before the orders lose their customer link; order ids, totals and items stay (accounting record, no identity). What was already DELIVERED to the merchant's own server cannot be recalled: the merchant is the controller of that copy and the 30-day purge bounds ours. Evidence: `tests/unit/webhook-erasure.test.ts` (SQL shape, call order), `tests/integration/merchant-webhooks.test.ts` (unrun, needs a database). Cost if wrong: a shopper's contact data survives up to 30 days in our log, or forever on the merchant's server.
