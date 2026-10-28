# SMS-4

> Section: 2026-10-02 — SMS marketing consent (branch `feat/sms-marketing-consent`, issue 206)

**Ruling SMS-4 — the checkbox renders only when the store can send promotional SMS** (sms feature on, provider configured with credentials, a promotional event enabled), via `smsMarketingOptIn` on the public store payload. Any other store renders nothing, so Storefront's checkout is pixel-identical. The value is BOUNDED-stale (rides the 120s store cache); the send gate re-checks live. Cost if wrong: a provider switched on shows the box up to about 12 minutes late (edge SWR), never early.
