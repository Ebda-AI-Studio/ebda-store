# EWO-A2

> Section: Cluster A — auth/session (orders, admin, storefront)

**Ruling EWO-A2 — issue 2160: logout is authoritative through a pending-logout marker, not a UI
toast.** `performLogout` writes `pendingLogout` (the iOS refresh token to revoke, empty on the cookie
path) BEFORE `POST /auth/logout` and removes it only on a 2xx. While it exists, every session check
(admin and orders, a reload of /login included) re-sends the logout instead of reading `/auth/me`
and reports `signed-out`; only an explicit login lifts it. The finding's second suggestion — surface
the failure and retry in the UI — is not built: the marker already retries on every check and the
user is shown signed out, which is the true client state. Residual: until connectivity returns the
server-side refresh token stays live (it was never revoked), so a stolen copy remains usable for that
window exactly as before. Cost if wrong: a staff member on a device that never regains connectivity
to the API keeps an un-revoked session server-side with no on-screen warning.
