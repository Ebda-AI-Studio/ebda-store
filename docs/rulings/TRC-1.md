# TRC-1

> Section: Tenant routing canary (2026-10-01, branch `feat/tenant-routing-canary`, PR 1979)

**Ruling TRC-1 — `STOREFRONT_TENANT_ROUTING_ROUTES` is fail-closed on presence, not only on value
(issue 1980).** Missing, empty, or unparseable routes NO store through the tenant tree, even with
`STOREFRONT_TENANT_ROUTING=true`; the full rollout is the explicit token `all`. "Unparseable" rejects
the WHOLE list when any token is unknown (`about,fqa` routes nothing rather than `/about` alone) and
when `all` is mixed with other tokens. Evidence: one test per state in
`tests/unit/web-middleware-tenant-routing.test.ts`, each reddened by its own mutant (missing→all,
empty→all, lenient parse, mixed-all→all) and restored byte-identical. Cost if wrong: an operator
who sets only the main flag, expecting the old "unset = all routes", sees no change until they add
`all`.
