# EWO-A12

> Section: Cluster A — auth/session (orders, admin, storefront)

**Ruling EWO-A12 — issue 2148: the refresh route's 400 is read as SESSION_ENDED on the storefront.**
Client-only fix: `/auth/refresh`'s only 400 is the "no refresh token presented" branch, which now
clears dead session cookies, so it is the same fact as the 401 — the CSRF-403'd write is retried
once on the SAME request and stale localStorage evidence is dropped. No server discriminator code
was added (keeps the defence-mutation `refresh-no-token-clears-dead-cookies` find-string intact). A
genuinely cookieless 400 costs at most one extra retry of a request that already failed. Admin and
orders keep `!res.ok → null`: an admin session is never the guest-CSRF victim (platform origins).
Cost if wrong: if the route ever grows a second 400 (e.g. body validation), a storefront CSRF-403
would be retried once needlessly and local session evidence cleared, costing one mount refresh.
