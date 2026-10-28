# ID-4

> Section: Lifecycle emails and referral attribution (2026-10-22, branch `feat/lifecycle-emails`)

Ruling ID-4 (2026-10-24) - identity refresh tokens are opaque, stored as sha256, rotated at most daily with a 60 s grace for parallel tabs; reuse outside the grace revokes the session. Cost if wrong: a stolen cookie is only noticed at its next rotation or reuse (bounded by the 30 day sliding window and per-session revocation).
