# CF-SCHEMA-5

> Section: Lifecycle emails and referral attribution (2026-10-22, branch `feat/lifecycle-emails`)

Ruling CF-SCHEMA-5 (2026-10-24) - CI-1 capture fields are built into the new schema (G3): `shipments.return_reason_raw` + `return_reason_code` (closed set, raw kept), `picked_up_at`, `delivered_at`, `attempts`, `area_key`; `orders.buyer_key` and `customers.buyer_key` (HMAC-SHA256 of the E.164 phone, per the WhatsApp contract; never the phone); an append-only `commerce_outcomes` table that is the outbox to Analytics Engine + R2. Cost if wrong: the return-reason code set is widened by a migration (the raw text is always stored).
