# SMS-2

> Section: 2026-10-02 — SMS marketing consent (branch `feat/sms-marketing-consent`, issue 206)

**Ruling SMS-2 — guests record nothing new (AUD-2).** A guest tick stores the order's own phone under the order's `customerKeyOf` key; no extra contact detail is collected. An unticked box writes nothing and is never a withdrawal. Cost if wrong: a guest who ticks and later orders under another email has two rows; withdrawal is phone-wide so it still stops.
