# EWO-A10

> Section: Cluster A — auth/session (orders, admin, storefront)

**Ruling EWO-A10 — issues 2164 / 2157: the storefront spends ONE evidence-free `/auth/me` refresh per
tab.** #2157 (anonymous page loads posting `/auth/refresh` into the shared `<ip>-refresh-anon`
bucket) was already closed on main by `hasSessionEvidence()`; #2164 shows that gate locked out the
Safari-ITP cohort (localStorage evicted, refresh cookie alive) it exists for. `claimSessionProbe`
(`apps/web/src/lib/api.ts`) lets exactly one `GET /auth/me` per tab session (`sessionStorage`
`authProbe`) refresh without evidence; no sessionStorage → no probe. Anonymous cost goes from 0 to at
most 1 refresh per tab (vs 1 per page load before #2157's gate). Evidence:
`tests/unit/storefront-session-refresh-gates.test.ts` (5 loads → 1 refresh; iOS cohort recovers;
removing the probe reddens 2 tests). Cost if wrong: on a heavily shared CGNAT IP the anon bucket
absorbs one extra POST per new tab, which could still tip a borderline IP into 429 for its signed-in
customers.
