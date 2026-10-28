# EWO-A11

> Section: Cluster A — auth/session (orders, admin, storefront)

**Ruling EWO-A11 — issues 2158 / 2098: the storefront gets the mount ladder; a transient `/auth/me`
answer is unknown, never signed out.** `getProfileWithMountRetries` (3 × 5s, same budget as
admin/orders) runs on mount with `isLoading` held true; RATE_LIMITED, TIMEOUT, NETWORK_ERROR,
INVALID_RESPONSE and server 5xx codes (`isTransientSessionAnswer`) are retried and, if they outlast
the ladder, leave `user` untouched — as does a later `refreshUser()` (the Ruling P2-B2-5 amendment's
"the next refreshUser() call gets another chance" was unreachable on mount; the AuthContext comment
now says what actually happens). Residual: under a sustained throttle every `isLoading`-gated
storefront surface (account pages, checkout's signed-in affordances) waits up to ~15s before
settling as a guest. Cost if wrong: a customer on a throttled IP sees a spinner for 15s and still
ends up a guest, exactly the pre-fix outcome but slower.
