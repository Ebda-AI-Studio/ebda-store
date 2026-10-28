# TRC-3

> Section: Tenant routing canary (2026-10-01, branch `feat/tenant-routing-canary`, PR 1979)

**Ruling TRC-3 — merged inert; production routing unchanged.** With both variables unset (prod
today, per the PR's 2026-09-25 `secret list`), the middleware returns responses byte-identical to
`origin/main` across 672 host × path × cookie cases, and with the main flag set but the list lost it
is also identical to flag-off `main` (positive control: `all` differs). The only other web changes
are in the `tenant-store` tree, which middleware 404s for direct hits and never rewrites into while
the flag is off. Not verified live: no deploy was made or inspected from this branch. Cost if wrong:
a secret set on `force-web-cf-preview` since 2026-09-25 that nobody recorded would activate on
deploy; `wrangler secret list` before merge settles it.
