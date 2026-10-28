# YWA-3

> Section: Backlog batch y-web-admin (2026-10-01)

**Ruling YWA-3: the iOS "no stored refresh token" bail-out yields to session evidence (issue
2320).** The `staleRefreshToken` heal drops the stored pair and continues on the rotated cookie.
The bail-out then returned `null` on the next expiry and signed a live session out. Admin and
orders now bail only when there is no stored token AND no `hasSessionEvidence()`, and the heal
records evidence. A signed-out iOS client still skips the call, because `clearStoredSession()`
removes the evidence. Cost if wrong: an iOS client whose cookie also died spends one `/auth/refresh`
(400), then signs out as before.
