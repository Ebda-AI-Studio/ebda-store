# EBDA-PWRESET-3

> Section: 2026-10-07 — Ebda Store forgot/reset password (branch `feat/password-reset`)

Ruling EBDA-PWRESET-3 — no explicit `timingSafeEqual` on the token. The lookup is an indexed equality match on `sha256(token)`, never on the plaintext; any timing signal from the index walk leaks bits of a hash of 256 random bits, which tells an attacker nothing about a live token (they cannot choose inputs whose hashes share a prefix with an unknown hash). A constant-time compare would require fetching candidate rows first, i.e. a weaker design. Cost if wrong: none known; this is the standard construction (OWASP Forgot Password Cheat Sheet).
