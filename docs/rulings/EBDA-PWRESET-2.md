# EBDA-PWRESET-2

> Section: 2026-10-07 — Ebda Store forgot/reset password (branch `feat/password-reset`)

Ruling EBDA-PWRESET-2 — the link lives 15 minutes, NOT the 30-60 the brief suggested. The 15 was set by the 2026-09-22 security audit (S5-2) for the same flow; lengthening it widens the window for a forwarded or intercepted mail, and the UX cost is one more "request a new link" click. One constant, `PASSWORD_RESET_TTL_MINUTES` in `@ebda/shared`, feeds the token expiry, the email copy and the admin pages, so the promise on screen cannot drift from the behaviour. Cost if wrong: merchants on slow mail delivery see more expired links — raise the constant, nothing else changes.
