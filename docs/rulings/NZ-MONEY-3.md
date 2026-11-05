# NZ-MONEY-3

> Section: NEON-ZERO money path (2026-11-05)

**Ruling NZ-MONEY-3 - money-out requests take an `Idempotency-Key`: same key, same answer, no second effect. `POST /payments/refund` claims it with an atomic `SET NX EX` on the AuthState store (`lib/money-idempotency.ts`; a failure after which money may have moved keeps it, so a retry gets 409 and a human checks the provider); `POST /stores/:id/affiliates/:id/payouts` passes it as the DO money-op key (the section replays its first payout). The gateway `refundKey` was NOT reused for this: it switches off the refund-outside-a-return GL / notification branch. Evidence: review M-6 / M-8 of PR 455. Cost if wrong: a client that reuses one key for two different refunds of the same payment gets the first answer back for the second (it must send a new key).**

Source: `docs/cf/payments-on-do.md` "NEON-ZERO money path".
