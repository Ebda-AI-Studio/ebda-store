# SMS-1

> Section: 2026-10-02 — SMS marketing consent (branch `feat/sms-marketing-consent`, issue 206)

**Ruling SMS-1 — consent is a per-store row keyed by `customerKeyOf`, not a flag on the caller's data.** `sms_marketing_consents` holds one row per (store, customer key); the promotional-SMS gate reads it for the recipient's phone and no producer passes a consent field. Orders keep `smsOptIn` only as a record of the tick. Cost if wrong: a producer that should have its own consent source (a future non-order channel) must add a row, not a flag.
