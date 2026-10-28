# PASSKEY-2

> Section: 2026-10-15 — Phase B1 Qamar (B1-\*)

Ruling PASSKEY-2 — challenges live in Redis for 300 s (floor is 120 s) under `passkey:ch:<sha256(challenge)>`, consumed with `DEL` (returns 1 for exactly one caller), bound to purpose, RP ID, origin, user and store; Redis down => 503, never "skip". Evidence: `tests/unit/passkey.service.test.ts` (replay, counter-0 replay, stored-key hash, fail closed); mutants that drop the `DEL` check turn the counter-0 replay red. Cost if wrong: a Redis outage disables passkey management and sign-in (password login is unaffected).
