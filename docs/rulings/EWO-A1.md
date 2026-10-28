# EWO-A1

> Section: Cluster A — auth/session (orders, admin, storefront)

**Ruling EWO-A1 — issues 2096 / 2161 / 2165: the admin + orders session check reports five outcomes, and
only `signed-out` changes state.** _(Amended by Ruling YWA-2: an API-bodied 404 on `/auth/me` is `signed-out`.)_ `checkSession` now returns `unavailable` for a non-401, non-429
answer on `/auth/me` (5xx during a deploy, a mis-routed 404) and `throttled` for a 429 there (so the
mount ladder retries it); `checkAuth` leaves `user` untouched on both. A module-level session
generation, bumped by every `storeSession` (login/MFA) and every logout, is re-checked before each
destructive step, and a check whose generation moved — or whose caller says a newer check started —
returns `superseded` and applies nothing. The orders provider keeps re-checking on every navigation
(#1814) but tags each run; an older ladder stops at its next sleep and only the newest run clears
`isLoading`. The session-check block stays byte-identical between `apps/admin/src/lib/api.ts` and
`apps/orders/src/lib/api.ts` (Ruling P2-B2-5). Evidence: `tests/unit/orders-auth-session-races.test.ts`,
7 mutations × 2 clients all red. Cost if wrong: a staff user whose `/auth/me` keeps 5xx-ing on a cold
mount (user already null) still lands on /login, where the next check recovers them — the same as before.
