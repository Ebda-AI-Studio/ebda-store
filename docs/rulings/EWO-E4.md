# EWO-E4

> Section: Cluster E — middleware, headers, static assets

**Ruling EWO-E4 — #709 and #1980 stay open: both are findings on the tenant-routing canary work,
and the fix belongs in open PR #1979 (`feat/tenant-routing-canary`), not this batch.** #1980's code
(`STOREFRONT_TENANT_ROUTING_ROUTES`) does not exist on `main` @ 726f4231. #709's duplicate
pixels/JSON-LD in `tenant-store/[tenant]/[locale]/layout.tsx` is real on `main` but inert
(`STOREFRONT_TENANT_ROUTING` unset everywhere) and PR #1979 item 2 removes it. Fixing either here
would conflict with that branch. Cost if wrong: if #1979 is abandoned, #709 must be picked up before
anyone sets the flag — the docs/ENVIRONMENT.md entry already says "do not set it anywhere yet".
