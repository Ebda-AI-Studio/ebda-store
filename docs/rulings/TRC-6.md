# TRC-6

> Section: 2026-10-02 — SMS marketing consent (branch `feat/sms-marketing-consent`, issue 206)

**Ruling TRC-6 — per-store scope for tenant routing: `STOREFRONT_TENANT_ROUTING_STORES`, fail-closed,
no `all` shortcut (2026-10-02).** Owner chose option (a) of TRC-5. The rewrite now needs three things:
the main flag is `true`, the route is in `STOREFRONT_TENANT_ROUTING_ROUTES`, and the resolved store is
in the new store list (`apps/web/middleware.ts`, `isTenantTreeEligible`). The store key is the same
identity the rewrite target already carries: the path or cookie slug on a platform host, the normalized
(lowercase, no `www.`) hostname on a custom domain. Missing, empty or unparseable routes NO store, as
TRC-1 does for routes. Two decisions inside it. (1) No `all` for stores: the literal token `all` is
rejected as unparseable and voids the whole list, so a store can only be switched on by being named, and
a lost or mistyped value can never widen the canary. A wildcard can be added later as its own ruling
once there is a reason. (2) A custom domain is allowlisted by HOSTNAME, not by slug. The ask was that
`demo-store.example` map to its slug, but middleware is synchronous and has no store lookup (a fetch there
would add latency to every request, and a transient API failure would decide routing); no static
domain-to-slug map exists in the repo, and inventing one would be a second source of truth for tenancy.
So slug tokens never match a custom domain, and `demo-store.example` is on only when that exact hostname
is listed. This is the safe direction: the demo-boutique canary (`demo-boutique`) cannot reach demo-store or demo-merchant
by any slug spelling. Evidence, `tests/unit/web-middleware-tenant-routing.test.ts`, 12 store tests:
list missing, empty, 14 garbage values (incl. `all`, `slug:demo-boutique`, `*`), contains demo-boutique, does not
contain demo-store, other platform slugs, bare-slug-vs-host, route list still narrows, main flag off,
preview iframe. Six mutants each reddened at least one test and were restored byte-identical: gate
removed (7 red), missing=allow (3), `all` accepted (1), partial parse (1), cookie path ignoring the store
(1), custom-domain key forced to demo-boutique (2). Parity, 672 host x path x cookie cases against
`origin/main`'s middleware: variable unset (flag on + routes `about,faq`) identical in all 672; with the
variable set to `demo-boutique` only, all 546 non-demo-boutique cases identical to main under prod env and the 30
demo-boutique-related cases that differ are the intended rewrites; control listing demo-store.example and
demo-merchant.com does change them. Not verified: nothing was set or deployed; no live request was made. One
parity run reported 1 unexplained difference on the all-unset check and did not reproduce in 16 reruns;
middleware has no time or random source, so it is recorded here rather than dismissed. Cost if wrong:
a store reachable under a custom domain AND a platform slug needs both spellings listed, and an operator
who lists a slug expecting it to cover the custom domain sees that domain unchanged until its hostname is added.
