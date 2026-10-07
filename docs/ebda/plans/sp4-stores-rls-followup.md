# SP4 follow-up: strict RLS on `stores`

Status: DONE 2026-10-07 (R-EBDA-005, branch `feat/tenant-defence` + its stacked contract PR). Steps 1-5 below were carried out: `store_credentials`, the definers (named differently: `ebda_store_lookup`, `ebda_store_id_by_slug`, `ebda_store_id_by_domain`, `ebda_store_ids_claiming_domain`, `ebda_store_directory`, `ebda_public_store_page`, `ebda_owned_store_ids`, `ebda_wbs_bridge_keys`), the `stores` policy (own store, owner, staff, active super_admin), every call site converted (and checked at runtime by the code-level tenant guard, R-EBDA-003), and `stores` removed from `DOCUMENTED_NON_RLS`. Kept below as the original plan. Original decision date 2026-10-04.

## Why it is not in SP4

`stores` is read or written at **304 call sites in 106 files** (grep below), far over the ~40-site budget set for this task. Most are legitimately store-scoped, but about a third run BEFORE any scope exists (host resolution, API-key and MCP auth, WA bridge auth, the `acrossStores` store listing, every Inngest sweep, super-admin lists, provisioning, signup slug checks) and would need a definer. Every relation join from a tenant table to its store is also affected. Doing this under the SP4 deadline would mean rewriting the auth and cron entry points without the per-path tests they need.

## What the residual is

`ebda_app` can `SELECT` every row of `stores`, including the encrypted provider credential columns (`wbs_api_key`, `meta_access_token`, `agent_api_key`). The Prisma client omits those columns by default, so an app bug has to opt in to read them; a SQL-injection-capable attacker would not need to. Tenant data in every other table is isolated.

## Plan

1. Move the secret columns out of `stores` into a store-scoped table (`store_credentials`, strict policy) so the routing table holds no secrets. This alone closes the residual and is a small change (three columns and their encrypt/decrypt call sites).

2. Add definers for the pre-scope reads: `ebda_store_slug_taken(slug)`, `ebda_store_routing(id)` (slug, domain, status, plan), `ebda_list_store_ids(filter)` for `acrossStores`, and owner lookups for the MCP and WA bridge auth.

3. Enable RLS on `stores`: USING (id = current store OR owner_id = current user OR a store_staff row for the current user OR `ebda_is_super_admin()`), with the same WITH CHECK; provisioning needs a definer or an insert policy keyed on the acting user because the store row exists before its store GUC can be set.

4. Convert the call sites below by category, one change per category, each with a contextless-read-returns-0 and other-store-returns-0 test on a real `ebda_app` login.

5. Remove `stores` from `DOCUMENTED_NON_RLS` in `tests/integration/rls-ebda-app.test.ts`.

## Call sites by category (grep, `apps/api/src` and `packages/database/src`)

### Pre-scope resolution (host, auth, API keys, MCP, WA bridge)

- `apps/api/src/routes/agent-credential.routes.ts` (5)
- `apps/api/src/middleware/store-access.ts` (2)
- `apps/api/src/mcp/agent-auth.ts` (1)
- `apps/api/src/mcp/resolve-store.ts` (1)
- `apps/api/src/middleware/wa-bridge-auth.ts` (1)
- `apps/api/src/routes/merchant-key.routes.ts` (1)
- `apps/api/src/utils/store-helpers.ts` (1)

### Cross-store crons and fan-out (acrossStores listing, Inngest)

- `apps/api/src/lib/inngest/functions/bulk-ai-aeo.ts` (8)
- `apps/api/src/lib/inngest/functions/bulk-ai-geo.ts` (6)
- `apps/api/src/lib/inngest/functions/bulk-ai-seo.ts` (4)
- `apps/api/src/lib/inngest/functions/bulk-ai-translate.ts` (3)
- `apps/api/src/lib/inngest/functions/stock-low-stock-alert.ts` (3)
- `apps/api/src/lib/inngest/functions/answer-engine-citation-scan.ts` (2)
- `apps/api/src/lib/inngest/functions/gsc-ingest.ts` (2)
- `apps/api/src/lib/inngest/functions/order-whatsapp-notify.ts` (2)
- `apps/api/src/lib/inngest/functions/queue-depth-watch.ts` (2)
- `apps/api/src/lib/inngest/functions/stock-deadstock-scan.ts` (2)
- `apps/api/src/lib/inngest/functions/stock-reorder-scan.ts` (2)
- `apps/api/src/lib/cross-store.ts` (1)
- `apps/api/src/lib/inngest/functions/accounting-daily-close.ts` (1)
- `apps/api/src/lib/inngest/functions/accounting-period-reconciliation.ts` (1)
- `apps/api/src/lib/inngest/functions/accounting-profit-anomaly.ts` (1)
- `apps/api/src/lib/inngest/functions/agent-write-denied-watch.ts` (1)
- `apps/api/src/lib/inngest/functions/ai-autofill-sweep.ts` (1)
- `apps/api/src/lib/inngest/functions/analytics-daily-rollup.ts` (1)
- `apps/api/src/lib/inngest/functions/bulk-ai-categorize.ts` (1)
- `apps/api/src/lib/inngest/functions/bulk-ai-excerpt.ts` (1)
- `apps/api/src/lib/inngest/functions/bulk-ai-product-faqs.ts` (1)
- `apps/api/src/lib/inngest/functions/bulk-ai-tags.ts` (1)
- `apps/api/src/lib/inngest/functions/campaign-send.ts` (1)
- `apps/api/src/lib/inngest/functions/order-status-changed.ts` (1)
- `apps/api/src/lib/inngest/functions/payment-abandonment-sweep.ts` (1)
- `apps/api/src/lib/inngest/functions/payment-reconcile-sweep.ts` (1)
- `apps/api/src/lib/inngest/functions/product-meta-sync.ts` (1)
- `apps/api/src/lib/inngest/functions/review-request.ts` (1)
- `apps/api/src/lib/inngest/functions/store-usage-snapshot.ts` (1)
- `packages/database/src/index.ts` (1)

### Super-admin and provisioning

- `apps/api/src/services/store.service.ts` (23)
- `apps/api/src/routes/admin.routes.ts` (16)
- `apps/api/src/routes/store.routes.ts` (8)
- `apps/api/src/services/provisioning.service.ts` (6)
- `apps/api/src/services/plan-limit.service.ts` (2)
- `apps/api/src/services/plan.service.ts` (2)
- `apps/api/src/services/plan-entitlements.ts` (1)

### Public storefront routes

- `apps/api/src/routes/public.routes.ts` (7)
- `apps/api/src/services/pwa.service.ts` (6)
- `apps/api/src/routes/campaign-public.routes.ts` (1)
- `apps/api/src/routes/newsletter.routes.ts` (1)
- `apps/api/src/routes/public-store-layout.routes.ts` (1)
- `apps/api/src/routes/pwa.routes.ts` (1)

### Store-scoped services and routes (already inside a store scope)

- `apps/api/src/services/email.service.ts` (16)
- `apps/api/src/services/resend.service.ts` (12)
- `apps/api/src/services/loyalty.service.ts` (11)
- `apps/api/src/routes/ai.routes.ts` (8)
- `apps/api/src/routes/wbs-integration.routes.ts` (6)
- `apps/api/src/routes/payment-settings.routes.ts` (5)
- `apps/api/src/routes/wa-bridge.routes.ts` (5)
- `apps/api/src/services/billing/subscription-billing.service.ts` (5)
- `apps/api/src/services/onboarding.service.ts` (5)
- `apps/api/src/services/payment-providers/payment.factory.ts` (5)
- `apps/api/src/routes/wa-templates.routes.ts` (4)
- `apps/api/src/services/feature.service.ts` (4)
- `apps/api/src/services/product.service.ts` (4)
- `apps/api/src/routes/category.routes.ts` (3)
- `apps/api/src/routes/payment.routes.ts` (3)
- `apps/api/src/routes/store-layout.routes.ts` (3)
- `apps/api/src/routes/typography.routes.ts` (3)
- `apps/api/src/services/setup-guide.service.ts` (3)
- `apps/api/src/routes/campaign.routes.ts` (2)
- `apps/api/src/services/abandoned-cart.service.ts` (2)
- `apps/api/src/services/ai-autofill.service.ts` (2)
- `apps/api/src/services/tax.service.ts` (2)
- `apps/api/src/lib/ai/review-tools.ts` (1)
- `apps/api/src/lib/order-tax.ts` (1)
- `apps/api/src/lib/report-range.ts` (1)
- `apps/api/src/routes/blog.routes.ts` (1)
- `apps/api/src/routes/bot-analytics.routes.ts` (1)
- `apps/api/src/routes/customers.routes.ts` (1)
- `apps/api/src/routes/feature.routes.ts` (1)
- `apps/api/src/routes/locations.routes.ts` (1)
- `apps/api/src/routes/order.routes.ts` (1)
- `apps/api/src/routes/payment-links.routes.ts` (1)
- `apps/api/src/services/accounting/expense.service.ts` (1)
- `apps/api/src/services/accounting/insights-narration.service.ts` (1)
- `apps/api/src/services/accounting/posting/expense-posting.ts` (1)
- `apps/api/src/services/accounting/posting/order-posting.ts` (1)
- `apps/api/src/services/accounting/posting/po-receive-posting.ts` (1)
- `apps/api/src/services/accounting/posting/stock-adjustment-posting.ts` (1)
- `apps/api/src/services/accounting/profit-anomaly.service.ts` (1)
- `apps/api/src/services/answer-engine/citation-scan.service.ts` (1)
- `apps/api/src/services/answer-engine/gsc-ingest.service.ts` (1)
- `apps/api/src/services/billing/billing-notify.ts` (1)
- `apps/api/src/services/inventory.service.ts` (1)
- `apps/api/src/services/inventory/low-stock-scan.service.ts` (1)
- `apps/api/src/services/locations.service.ts` (1)
- `apps/api/src/services/loyalty-automation.service.ts` (1)
- `apps/api/src/services/notification-dispatcher.service.ts` (1)
- `apps/api/src/services/order.service.ts` (1)
- `apps/api/src/services/pixels-capi.service.ts` (1)
- `apps/api/src/services/r2-cleanup.service.ts` (1)
- `apps/api/src/services/return.service.ts` (1)
- `apps/api/src/services/socket.service.ts` (1)
- `apps/api/src/services/wallet.service.ts` (1)

### Added by the SP5 merges (stores-only, no tenant table involved)

- `apps/api/src/services/domain-claim.service.ts` and the `domain-claim-sweep` cron read and write only `stores`; they need the same routing definers as the rest (pending-claim scan: `ebda_list_pending_domain_claims`).
- `apps/api/src/services/onboarding.service.ts` slug check and owner store count; `card-testing-guard.service.ts` store name for the alert.

The category split is by file name and is a starting point: each site must still be classified (in scope or pre-scope) while converting.
