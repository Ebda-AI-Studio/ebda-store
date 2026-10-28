# TRC-5

> Section: 2026-10-02 — SMS marketing consent (branch `feat/sms-marketing-consent`, issue 206)

**Ruling TRC-5 — issue 2407: while the root layout owns the store chrome, it also owns the document
metadata; the tenant tree resolves locale the way the root does, not from its `[locale]` segment.**
The tenant-store layout's `generateMetadata` returns `{}` while `ROOT_LAYOUT_OWNS_STORE_CHROME` is
true (Next lets a nested layout's metadata replace the root's, and the segment is cookie-only: a
cookie-less crawler got `en` on an Arabic-default store, so an English title and `og:locale` sat over
`<html lang="ar">`). The tenant product page's metadata and body use `resolveStorefrontLocale`
(cookie, then store default) for the same reason. The middleware is unchanged and the main flag is
still off in prod, so nothing renders differently today; with it on, the merged metadata is proven
equal to flag-off for no cookie, `en` and `ar` in
`tests/unit/web-tenant-tree-store-chrome-render.test.tsx` (removing the early return reddens the
cookie-less case, restored byte-identical). That proof is LAYOUT-level only; page-level parity (title,
description, canonical, robots per route, tenant page vs its legacy twin) is
`tests/unit/web-tenant-tree-page-metadata-parity.test.tsx` (issue 2418: the tenant categories page had
dropped the legacy store-aware canonical; reverting the fix reddens `/categories`). Accepted residual: the tree stays dynamic for metadata
until the root-layout decomposition; the Phase 4 cache-key blocker (no-cookie visitor shares the `en`
key) in the plan is unchanged and still has to be fixed in middleware before pages cache. Cost if wrong:
a later change that reads the route segment for metadata again re-opens the English-over-Arabic
index for cookie-less crawlers.

---

> Section: 2026-10-02 — SMS marketing consent (branch `feat/sms-marketing-consent`, issue 206)

**Ruling TRC-5 — the single-store canary on demo-boutique was NOT started: the routing switch cannot
be scoped to one store (2026-10-01).** The owner asked for the production canary on demo-boutique only
(store.ebda.app/demo-boutique), never demo-store, and to stop rather than flip globally if the switch had
no per-store scope. It has none. The rewrite is gated by exactly two Worker-wide values,
`STOREFRONT_TENANT_ROUTING` (`=== 'true'`) and `STOREFRONT_TENANT_ROUTING_ROUTES` (a ROUTE list),
both read from `process.env` in `apps/web/middleware.ts` (`isTenantTreeEligible`). No input to that
gate identifies a store, and one Worker, `force-web-cf-preview`, serves every store:
`scripts/cf-setup-local.sh` routes `store.ebda.app` (demo-boutique), `demo-store.example/*` and the
`*/*` SaaS fallback (demo-merchant.com) to it. Live check 2026-10-01: all three return 200 from
Cloudflare, with `x-store-domain` set to `demo-store.example` and `demo-merchant.com` on the custom
domains. So `about,faq` would rewrite demo-store's and demo-merchant's `/about` and `/faq` in the same
instant as demo-boutique's. Current state, read from an empty directory with
`CLOUDFLARE_ACCOUNT_ID=9f70414f9a626137f1004fa2f4add904 wrangler secret list --name force-web-cf-preview`
(exit 0): the only secret is `REVALIDATE_SECRET`. Both routing variables are unset, which is
consistent with TRC-3. Nothing was set, deployed or deleted, and no baseline was captured,
because no change followed. `cf-deploy.yml` never sets either variable. They are secrets only.
Unblock options, for the owner to choose between: (a) a code PR that adds a fail-closed store
allowlist (e.g. `STOREFRONT_TENANT_ROUTING_STORES`, matched on `slug:<slug>` or the custom domain,
missing or empty meaning no store, as TRC-1 does for routes), then the demo-boutique canary as asked; or
(b) accept a route-scoped canary on every store at once, which the owner's "never demo-store" rules
out today. The rollback, once any canary is set, is to delete the main flag, from an empty
directory:
`CLOUDFLARE_ACCOUNT_ID=9f70414f9a626137f1004fa2f4add904 npx wrangler secret delete STOREFRONT_TENANT_ROUTING --name force-web-cf-preview`.
Deleting it makes the flag unset, which is inert, and no redeploy is needed. Cost if wrong: if a
store scope exists outside `middleware.ts`, the canary was held back one PR for nothing. The grep
across `apps/`, `docs/` and `.github/` for a store-scoped routing variable found none.
