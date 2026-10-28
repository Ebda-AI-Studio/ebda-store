# WH-5

> Section: 2026-10-15 — Phase B1 Qamar (B1-\*)

Ruling WH-5 (2026-10-21) — the outgoing routes live in `apps/api/src/routes/merchant-webhooks.routes.ts`; `routes/webhook.routes.ts` is the INBOUND payment/carrier router and must stay untouched by this feature. A first commit (51e748018) overwrote it through a file-name collision; the security review caught it, it was restored from origin/main (empty diff), and `tests/unit/inbound-payment-webhook-routes.test.ts` + `tests/unit/inbound-payment-webhook-integrity.test.ts` pin the missing-signature refusal, the replay short-circuit, store ownership, INVALID_SIGNATURE and the underpaid hold (each mutation-checked red). Cost if wrong: an unnoticed regression there lets a forged "paid" event ship goods.
