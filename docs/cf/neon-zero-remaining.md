# NEON-ZERO remaining Postgres dependencies (N-15 route sweep)

Source: `apps/api/workers-test/route-sweep.test.ts` on `integ/neon-zero` (all twelve NEON-ZERO PRs merged), the BUILT Worker, Postgres at a dead port (`EBDA_WORKERS_TEST_DB_URL=postgresql://ebda_app:x@127.0.0.1:1/x`), a store created on D1 + its Durable Object (N-18), every cutover marker set in D1 (`platform_cutover.{billing,access,platform,inbox,ai-usage,analytics}`, `customer_auth_cutover.__all`), tokens for store_admin (the store owner), super_admin and a storefront customer.

Measured: **907 requests** over the real router table (858 method+path pairs + the storefront flow, webhooks and cron ticks): **100 2xx**, **538 expected 4xx** (validation, not-found, plan-gate 402/403, unauthenticated), **269 failing (5xx or no answer)** over **268 distinct routes**. Every one of the 5xx is `connection attempt failed` from the first Postgres use (the request opened Postgres); the exceptions are listed under their own heading.

Reproduce: `cd apps/api && npm run cf:dry-run && EBDA_WORKERS_TEST_DB_URL=postgresql://ebda_app:x@127.0.0.1:1/x npx vitest run --config vitest.workers.config.mts workers-test/route-sweep.test.ts --silent=false --reporter=verbose` (one `SWEEP_RESULT {json}` line per request; `SWEEP_STRICT=1` makes any 5xx a red test). The route list is `apps/api/workers-test/route-table.json`, kept equal to the real router by `tests/unit/route-table-manifest.test.ts`.

Stack top: the Postgres connect error is raised in `packages/database/src/client-pool.ts:73` (pg-pool) and re-thrown through `apps/api/src/cf/database-role-guard.ts:33`, the lazy role check that runs on the first Postgres use of a request. The calling handler frame is not in the async chain (workerd keeps ~17 async frames), so the route path IS the locator; a handler that throws its own error shows that frame instead.

Fixed after the sweep (fix/nz-analytics-routes, Ruling NZ-INTEG-1): the nine `GET /stores/:storeId/analytics/*` routes (customers, low-stock, orders-by-status, payment-status, price-source, recent-orders, sales, top-categories, top-products) and `GET /stores/:storeId/ai/usage/{log,summary}` (the AI switch read the Store row from Postgres) now answer 200 with Postgres dead (SWEEP_ONLY='analytics|insights|ai-usage|/ai/usage|usage-history' SWEEP_STRICT=1). `GET /admin/super-admin/ai-usage/summary` and `/usage-history` are ported (D1 store list, D1 usage snapshots) but still answer 500 because EVERY `/admin/*` route opens the Postgres user-scoped request transaction (`adminUserContext`, `asPlatformOperator`) before its handler: that namespace-wide dependency is the open item for those two. `/admin/ci/insights` is the Customer Intelligence D1 family, not analytics.

Coordination: `origin/feat/nz-platform-d1-d` (N-10d) does not exist yet, so nothing was merged from it. Whoever writes N-10d should remove its rows from the tables below and keep this file's header.

Owner column: the PR whose plan item (docs/plans/2026-11-02-neon-zero.md) covers the area, or `unowned`. N-11 (per-store admin: ~118 service files without DO routing) has NO open PR and is the bulk of the list.

## unowned (N-11 per-store admin) (135 routes)

| Route                                                                 | Group        | Status | Cause                                                                            |
| --------------------------------------------------------------------- | ------------ | ------ | -------------------------------------------------------------------------------- |
| `GET /addresses/`                                                     | GET-merchant | 500    | Postgres connect (client-pool.ts:73 via database-role-guard first use)           |
| `POST /addresses/`                                                    | WRITE-empty  | 500    | Postgres connect (client-pool.ts:73 via database-role-guard first use)           |
| `DELETE /addresses/:id`                                               | WRITE-empty  | 500    | Postgres connect (client-pool.ts:73 via database-role-guard first use)           |
| `PUT /addresses/:id`                                                  | WRITE-empty  | 500    | Postgres connect (client-pool.ts:73 via database-role-guard first use)           |
| `POST /mcp/:storeSlug`                                                | WRITE-empty  | 500    | Postgres connect (client-pool.ts:73 via database-role-guard first use)           |
| `GET /onboarding/state`                                               | GET-merchant | 500    | Postgres connect (client-pool.ts:73 via database-role-guard first use)           |
| `POST /onboarding/store`                                              | WRITE-empty  | 500    | Postgres connect (client-pool.ts:73 via database-role-guard first use)           |
| `POST /onboarding/stores/:storeId/go-live`                            | WRITE-empty  | 500    | Postgres connect (client-pool.ts:73 via database-role-guard first use)           |
| `GET /payments/config`                                                | GET-merchant | 500    | Postgres connect (client-pool.ts:73 via database-role-guard first use)           |
| `GET /realtime/stores/:storeId/access`                                | GET-merchant | -1     | Error: The Workers runtime canceled this request because it detected that your W |
| `GET /stores/`                                                        | GET-merchant | 500    | Postgres connect (client-pool.ts:73 via database-role-guard first use)           |
| `POST /stores/:storeId/ai/apply-store-categories`                     | WRITE-empty  | 500    | Postgres connect (client-pool.ts:73 via database-role-guard first use)           |
| `POST /stores/:storeId/ai/builder-patch`                              | WRITE-empty  | 500    | Postgres connect (client-pool.ts:73 via database-role-guard first use)           |
| `GET /stores/:storeId/ai/bulk`                                        | GET-merchant | 500    | Postgres connect (client-pool.ts:73 via database-role-guard first use)           |
| `GET /stores/:storeId/ai/bulk/:jobId`                                 | GET-merchant | 500    | Postgres connect (client-pool.ts:73 via database-role-guard first use)           |
| `POST /stores/:storeId/ai/bulk/aeo-sweep-all`                         | WRITE-empty  | 500    | Postgres connect (client-pool.ts:73 via database-role-guard first use)           |
| `POST /stores/:storeId/ai/bulk/balance-descriptions`                  | WRITE-empty  | 500    | Postgres connect (client-pool.ts:73 via database-role-guard first use)           |
| `POST /stores/:storeId/ai/bulk/brand-facts`                           | WRITE-empty  | 500    | Postgres connect (client-pool.ts:73 via database-role-guard first use)           |
| `POST /stores/:storeId/ai/bulk/categorize`                            | WRITE-empty  | 500    | Postgres connect (client-pool.ts:73 via database-role-guard first use)           |
| `POST /stores/:storeId/ai/bulk/citation-copy`                         | WRITE-empty  | 500    | Postgres connect (client-pool.ts:73 via database-role-guard first use)           |
| `POST /stores/:storeId/ai/bulk/excerpt`                               | WRITE-empty  | 500    | Postgres connect (client-pool.ts:73 via database-role-guard first use)           |
| `POST /stores/:storeId/ai/bulk/faq-aeo`                               | WRITE-empty  | 500    | Postgres connect (client-pool.ts:73 via database-role-guard first use)           |
| `POST /stores/:storeId/ai/bulk/geo-sweep-all`                         | WRITE-empty  | 500    | Postgres connect (client-pool.ts:73 via database-role-guard first use)           |
| `POST /stores/:storeId/ai/bulk/howto-aeo`                             | WRITE-empty  | 500    | Postgres connect (client-pool.ts:73 via database-role-guard first use)           |
| `POST /stores/:storeId/ai/bulk/image-alt`                             | WRITE-empty  | 500    | Postgres connect (client-pool.ts:73 via database-role-guard first use)           |
| `POST /stores/:storeId/ai/bulk/llms-txt`                              | WRITE-empty  | 500    | Postgres connect (client-pool.ts:73 via database-role-guard first use)           |
| `POST /stores/:storeId/ai/bulk/meta-aeo`                              | WRITE-empty  | 500    | Postgres connect (client-pool.ts:73 via database-role-guard first use)           |
| `POST /stores/:storeId/ai/bulk/product-faqs`                          | WRITE-empty  | 500    | Postgres connect (client-pool.ts:73 via database-role-guard first use)           |
| `POST /stores/:storeId/ai/bulk/recommendations`                       | WRITE-empty  | 500    | Postgres connect (client-pool.ts:73 via database-role-guard first use)           |
| `POST /stores/:storeId/ai/bulk/revert-balance`                        | WRITE-empty  | 500    | Postgres connect (client-pool.ts:73 via database-role-guard first use)           |
| `POST /stores/:storeId/ai/bulk/seo`                                   | WRITE-empty  | 500    | Postgres connect (client-pool.ts:73 via database-role-guard first use)           |
| `POST /stores/:storeId/ai/bulk/tags`                                  | WRITE-empty  | 500    | Postgres connect (client-pool.ts:73 via database-role-guard first use)           |
| `POST /stores/:storeId/ai/bulk/translate`                             | WRITE-empty  | 500    | Postgres connect (client-pool.ts:73 via database-role-guard first use)           |
| `POST /stores/:storeId/ai/jobs/:jobId/cancel`                         | WRITE-empty  | 500    | Postgres connect (client-pool.ts:73 via database-role-guard first use)           |
| `POST /stores/:storeId/ai/palette-from-logo`                          | WRITE-empty  | 500    | Postgres connect (client-pool.ts:73 via database-role-guard first use)           |
| `POST /stores/:storeId/ai/product-faqs/draft`                         | WRITE-empty  | 500    | Postgres connect (client-pool.ts:73 via database-role-guard first use)           |
| `POST /stores/:storeId/ai/product-meta-aeo`                           | WRITE-empty  | 500    | Postgres connect (client-pool.ts:73 via database-role-guard first use)           |
| `POST /stores/:storeId/ai/products/:productId/ai/balance-description` | WRITE-empty  | 500    | Postgres connect (client-pool.ts:73 via database-role-guard first use)           |
| `POST /stores/:storeId/ai/products/:productId/ai/reset-field`         | WRITE-empty  | 500    | Postgres connect (client-pool.ts:73 via database-role-guard first use)           |
| `POST /stores/:storeId/ai/products/:productId/ai/revert-balance`      | WRITE-empty  | 500    | Postgres connect (client-pool.ts:73 via database-role-guard first use)           |
| `GET /stores/:storeId/ai/results/categorize`                          | GET-merchant | 500    | Postgres connect (client-pool.ts:73 via database-role-guard first use)           |
| `GET /stores/:storeId/ai/results/excerpt`                             | GET-merchant | 500    | Postgres connect (client-pool.ts:73 via database-role-guard first use)           |
| `GET /stores/:storeId/ai/results/faqs`                                | GET-merchant | 500    | Postgres connect (client-pool.ts:73 via database-role-guard first use)           |
| `GET /stores/:storeId/ai/results/geo`                                 | GET-merchant | 500    | Postgres connect (client-pool.ts:73 via database-role-guard first use)           |
| `GET /stores/:storeId/ai/results/howtos`                              | GET-merchant | 500    | Postgres connect (client-pool.ts:73 via database-role-guard first use)           |
| `GET /stores/:storeId/ai/results/image-alt`                           | GET-merchant | 500    | Postgres connect (client-pool.ts:73 via database-role-guard first use)           |
| `GET /stores/:storeId/ai/results/meta-aeo`                            | GET-merchant | 500    | Postgres connect (client-pool.ts:73 via database-role-guard first use)           |
| `GET /stores/:storeId/ai/results/recommendations`                     | GET-merchant | 500    | Postgres connect (client-pool.ts:73 via database-role-guard first use)           |
| `GET /stores/:storeId/ai/results/recommendations/overview`            | GET-merchant | 500    | Postgres connect (client-pool.ts:73 via database-role-guard first use)           |
| `GET /stores/:storeId/ai/results/seo`                                 | GET-merchant | 500    | Postgres connect (client-pool.ts:73 via database-role-guard first use)           |
| `GET /stores/:storeId/ai/results/tags`                                | GET-merchant | 500    | Postgres connect (client-pool.ts:73 via database-role-guard first use)           |
| `GET /stores/:storeId/ai/results/translate`                           | GET-merchant | 500    | Postgres connect (client-pool.ts:73 via database-role-guard first use)           |
| `POST /stores/:storeId/ai/section-content`                            | WRITE-empty  | 500    | Postgres connect (client-pool.ts:73 via database-role-guard first use)           |
| `POST /stores/:storeId/ai/seo`                                        | WRITE-empty  | 500    | Postgres connect (client-pool.ts:73 via database-role-guard first use)           |
| `GET /stores/:storeId/ai/settings`                                    | GET-merchant | 500    | Postgres connect (client-pool.ts:73 via database-role-guard first use)           |
| `POST /stores/:storeId/ai/suggest-categories`                         | WRITE-empty  | 500    | Postgres connect (client-pool.ts:73 via database-role-guard first use)           |
| `POST /stores/:storeId/ai/suggest-store-categories`                   | WRITE-empty  | 500    | Postgres connect (client-pool.ts:73 via database-role-guard first use)           |
| `POST /stores/:storeId/ai/translate`                                  | WRITE-empty  | 500    | Postgres connect (client-pool.ts:73 via database-role-guard first use)           |
| `GET /stores/:storeId/ci/overview`                                    | GET-merchant | 500    | Postgres connect (client-pool.ts:73 via database-role-guard first use)           |
| `GET /stores/:storeId/coupons`                                        | GET-merchant | 500    | Postgres connect (client-pool.ts:73 via database-role-guard first use)           |
| `GET /stores/:storeId/coupons/:id`                                    | GET-merchant | 500    | Postgres connect (client-pool.ts:73 via database-role-guard first use)           |
| `DELETE /stores/:storeId/coupons/:id`                                 | WRITE-empty  | 500    | Postgres connect (client-pool.ts:73 via database-role-guard first use)           |
| `PUT /stores/:storeId/coupons/:id`                                    | WRITE-empty  | 500    | Postgres connect (client-pool.ts:73 via database-role-guard first use)           |
| `PATCH /stores/:storeId/coupons/:id/toggle`                           | WRITE-empty  | 500    | Postgres connect (client-pool.ts:73 via database-role-guard first use)           |
| `GET /stores/:storeId/customer-groups`                                | GET-merchant | 500    | Postgres connect (client-pool.ts:73 via database-role-guard first use)           |
| `GET /stores/:storeId/customer-groups/:id`                            | GET-merchant | 500    | Postgres connect (client-pool.ts:73 via database-role-guard first use)           |
| `DELETE /stores/:storeId/customer-groups/:id`                         | WRITE-empty  | 500    | Postgres connect (client-pool.ts:73 via database-role-guard first use)           |
| `PUT /stores/:storeId/customer-groups/:id`                            | WRITE-empty  | 500    | Postgres connect (client-pool.ts:73 via database-role-guard first use)           |
| `GET /stores/:storeId/customers`                                      | GET-merchant | 500    | Postgres connect (client-pool.ts:73 via database-role-guard first use)           |
| `GET /stores/:storeId/customers/:customerKey`                         | GET-merchant | 500    | Postgres connect (client-pool.ts:73 via database-role-guard first use)           |
| `GET /stores/:storeId/customers/export.xlsx`                          | GET-merchant | 500    | Postgres connect (client-pool.ts:73 via database-role-guard first use)           |
| `GET /stores/:storeId/finance/anomalies`                              | GET-merchant | 500    | Postgres connect (client-pool.ts:73 via database-role-guard first use)           |
| `POST /stores/:storeId/finance/anomalies/:id/acknowledge`             | WRITE-empty  | 500    | Postgres connect (client-pool.ts:73 via database-role-guard first use)           |
| `GET /stores/:storeId/gold-rates/`                                    | GET-merchant | 500    | Postgres connect (client-pool.ts:73 via database-role-guard first use)           |
| `GET /stores/:storeId/gold-rates/history`                             | GET-merchant | 500    | Postgres connect (client-pool.ts:73 via database-role-guard first use)           |
| `GET /stores/:storeId/gold-rates/payment-policy`                      | GET-merchant | 500    | Postgres connect (client-pool.ts:73 via database-role-guard first use)           |
| `GET /stores/:storeId/inventory/history`                              | GET-merchant | 500    | Postgres connect (client-pool.ts:73 via database-role-guard first use)           |
| `GET /stores/:storeId/inventory/products`                             | GET-merchant | 500    | Postgres connect (client-pool.ts:73 via database-role-guard first use)           |
| `GET /stores/:storeId/inventory/products/:productId/history`          | GET-merchant | 500    | Postgres connect (client-pool.ts:73 via database-role-guard first use)           |
| `GET /stores/:storeId/inventory/stats`                                | GET-merchant | 500    | Postgres connect (client-pool.ts:73 via database-role-guard first use)           |
| `POST /stores/:storeId/orders/`                                       | WRITE-empty  | 500    | Session ID required @ src/routes/order.routes.ts:554                             |
| `POST /stores/:storeId/orders/:orderId/mark-paid`                     | WRITE-empty  | 500    | Postgres connect (client-pool.ts:73 via database-role-guard first use)           |
| `GET /stores/:storeId/orders/:orderId/packing-slip`                   | GET-merchant | 500    | Postgres connect (client-pool.ts:73 via database-role-guard first use)           |
| `POST /stores/:storeId/orders/:orderId/payment-link`                  | WRITE-empty  | 500    | Postgres connect (client-pool.ts:73 via database-role-guard first use)           |
| `POST /stores/:storeId/orders/:orderId/refresh-payment-status`        | WRITE-empty  | 500    | Postgres connect (client-pool.ts:73 via database-role-guard first use)           |
| `POST /stores/:storeId/orders/:orderId/refresh-refund-status`         | WRITE-empty  | 500    | Postgres connect (client-pool.ts:73 via database-role-guard first use)           |
| `POST /stores/:storeId/orders/:orderId/refund-via-provider`           | WRITE-empty  | 500    | Postgres connect (client-pool.ts:73 via database-role-guard first use)           |
| `GET /stores/:storeId/orders/:orderId/timeline`                       | GET-merchant | 500    | Postgres connect (client-pool.ts:73 via database-role-guard first use)           |
| `GET /stores/:storeId/orders/export.xlsx`                             | GET-merchant | 500    | Postgres connect (client-pool.ts:73 via database-role-guard first use)           |
| `DELETE /stores/:storeId/product-models/:productId`                   | WRITE-empty  | 500    | Postgres connect (client-pool.ts:73 via database-role-guard first use)           |
| `PUT /stores/:storeId/product-models/:productId`                      | WRITE-empty  | 500    | Postgres connect (client-pool.ts:73 via database-role-guard first use)           |
| `POST /stores/:storeId/products`                                      | FLOW         | 500    | Product: stock columns are not written here @ packages/repo/src/rpc/reads.ts:70  |
| `DELETE /stores/:storeId/products/:productId/relations/:relationId`   | WRITE-empty  | 500    | Relation not found @ src/services/recommendation.service.ts:454                  |
| `GET /stores/:storeId/promotions`                                     | GET-merchant | 500    | Postgres connect (client-pool.ts:73 via database-role-guard first use)           |
| `GET /stores/:storeId/promotions/:id`                                 | GET-merchant | 500    | Postgres connect (client-pool.ts:73 via database-role-guard first use)           |
| `DELETE /stores/:storeId/promotions/:id`                              | WRITE-empty  | 500    | Postgres connect (client-pool.ts:73 via database-role-guard first use)           |
| `PUT /stores/:storeId/promotions/:id`                                 | WRITE-empty  | 500    | Postgres connect (client-pool.ts:73 via database-role-guard first use)           |
| `PATCH /stores/:storeId/promotions/:id/toggle`                        | WRITE-empty  | 500    | Postgres connect (client-pool.ts:73 via database-role-guard first use)           |
| `GET /stores/:storeId/pwa/settings`                                   | GET-merchant | 500    | Postgres connect (client-pool.ts:73 via database-role-guard first use)           |
| `PUT /stores/:storeId/pwa/settings`                                   | WRITE-empty  | 500    | Postgres connect (client-pool.ts:73 via database-role-guard first use)           |
| `POST /stores/:storeId/reviews/admin/:id/draft-response`              | WRITE-empty  | 500    | Postgres connect (client-pool.ts:73 via database-role-guard first use)           |
| `PUT /stores/:storeId/reviews/admin/:id/owner-response`               | WRITE-empty  | 500    | Postgres connect (client-pool.ts:73 via database-role-guard first use)           |
| `POST /stores/:storeId/reviews/admin/products/:productId/summary`     | WRITE-empty  | 500    | Postgres connect (client-pool.ts:73 via database-role-guard first use)           |
| `GET /stores/:storeId/setup-guide`                                    | GET-merchant | 500    | Postgres connect (client-pool.ts:73 via database-role-guard first use)           |
| `GET /stores/:storeId/shipping`                                       | GET-merchant | 500    | Postgres connect (client-pool.ts:73 via database-role-guard first use)           |
| `GET /stores/:storeId/shipping/:id`                                   | GET-merchant | 500    | Postgres connect (client-pool.ts:73 via database-role-guard first use)           |
| `DELETE /stores/:storeId/shipping/:id`                                | WRITE-empty  | 500    | Postgres connect (client-pool.ts:73 via database-role-guard first use)           |
| `PUT /stores/:storeId/shipping/:id`                                   | WRITE-empty  | 500    | Postgres connect (client-pool.ts:73 via database-role-guard first use)           |
| `PATCH /stores/:storeId/shipping/:id/toggle`                          | WRITE-empty  | 500    | Postgres connect (client-pool.ts:73 via database-role-guard first use)           |
| `GET /stores/:storeId/shipping/area-rates`                            | GET-merchant | 500    | Postgres connect (client-pool.ts:73 via database-role-guard first use)           |
| `DELETE /stores/:storeId/shipping/area-rates/:id`                     | WRITE-empty  | 500    | Postgres connect (client-pool.ts:73 via database-role-guard first use)           |
| `PATCH /stores/:storeId/shipping/area-rates/:id`                      | WRITE-empty  | 500    | Postgres connect (client-pool.ts:73 via database-role-guard first use)           |
| `GET /stores/:storeId/shipping/area-rates/export.xlsx`                | GET-merchant | 500    | Postgres connect (client-pool.ts:73 via database-role-guard first use)           |
| `PUT /stores/:storeId/shipping/reorder`                               | WRITE-empty  | 500    | Postgres connect (client-pool.ts:73 via database-role-guard first use)           |
| `GET /stores/:storeId/stock/deadstock-flags`                          | GET-merchant | 500    | Postgres connect (client-pool.ts:73 via database-role-guard first use)           |
| `POST /stores/:storeId/stock/deadstock-flags/:id/clearance`           | WRITE-empty  | 500    | Postgres connect (client-pool.ts:73 via database-role-guard first use)           |
| `POST /stores/:storeId/stock/deadstock-flags/:id/dismiss`             | WRITE-empty  | 500    | Postgres connect (client-pool.ts:73 via database-role-guard first use)           |
| `GET /stores/:storeId/stock/reorder-suggestions`                      | GET-merchant | 500    | Postgres connect (client-pool.ts:73 via database-role-guard first use)           |
| `POST /stores/:storeId/stock/reorder-suggestions/:id/accept`          | WRITE-empty  | 500    | Postgres connect (client-pool.ts:73 via database-role-guard first use)           |
| `POST /stores/:storeId/stock/reorder-suggestions/:id/dismiss`         | WRITE-empty  | 500    | Postgres connect (client-pool.ts:73 via database-role-guard first use)           |
| `GET /stores/:storeId/tax/profile`                                    | GET-merchant | 500    | Postgres connect (client-pool.ts:73 via database-role-guard first use)           |
| `DELETE /stores/:storeId/tax/profile/documents/:documentId`           | WRITE-empty  | 500    | Postgres connect (client-pool.ts:73 via database-role-guard first use)           |
| `GET /stores/:storeId/tax/profile/documents/:documentId/file`         | GET-merchant | 500    | Postgres connect (client-pool.ts:73 via database-role-guard first use)           |
| `GET /stores/:storeId/tax/rates`                                      | GET-merchant | 500    | Postgres connect (client-pool.ts:73 via database-role-guard first use)           |
| `GET /stores/:storeId/tax/rates/:id`                                  | GET-merchant | 500    | Postgres connect (client-pool.ts:73 via database-role-guard first use)           |
| `DELETE /stores/:storeId/tax/rates/:id`                               | WRITE-empty  | 500    | Postgres connect (client-pool.ts:73 via database-role-guard first use)           |
| `PUT /stores/:storeId/tax/rates/:id`                                  | WRITE-empty  | 500    | Postgres connect (client-pool.ts:73 via database-role-guard first use)           |
| `PATCH /stores/:storeId/tax/rates/:id/toggle`                         | WRITE-empty  | 500    | Postgres connect (client-pool.ts:73 via database-role-guard first use)           |
| `GET /stores/:storeId/tax/settings`                                   | GET-merchant | 500    | Postgres connect (client-pool.ts:73 via database-role-guard first use)           |
| `DELETE /stores/:storeId/whatsapp-link/`                              | WRITE-empty  | 500    | Postgres connect (client-pool.ts:73 via database-role-guard first use)           |
| `POST /stores/:storeId/wholesale-applications/:id/revoke`             | WRITE-empty  | 500    | Postgres connect (client-pool.ts:73 via database-role-guard first use)           |
| `GET /stores/:storeId/wholesale-applications/summary`                 | GET-merchant | 500    | Postgres connect (client-pool.ts:73 via database-role-guard first use)           |
| `GET /uploads/list`                                                   | GET-merchant | 503    | Storage service is not configured @ src/services/storage.service.ts:99           |

## unowned (N-10d super-admin hub: cross-store reads over DOs) (62 routes)

| Route                                                              | Group       | Status | Cause                                                                  |
| ------------------------------------------------------------------ | ----------- | ------ | ---------------------------------------------------------------------- |
| `GET /admin/:storeId/my-features`                                  | GET-admin   | 500    | Postgres connect (client-pool.ts:73 via database-role-guard first use) |
| `GET /admin/answer-engine/providers`                               | GET-admin   | 500    | Postgres connect (client-pool.ts:73 via database-role-guard first use) |
| `PUT /admin/answer-engine/providers/:engine`                       | WRITE-empty | 500    | Postgres connect (client-pool.ts:73 via database-role-guard first use) |
| `GET /admin/audit-logs`                                            | GET-admin   | 500    | Postgres connect (client-pool.ts:73 via database-role-guard first use) |
| `GET /admin/ci/gates`                                              | GET-admin   | 500    | Postgres connect (client-pool.ts:73 via database-role-guard first use) |
| `PUT /admin/ci/gates/:feature`                                     | WRITE-empty | 500    | Postgres connect (client-pool.ts:73 via database-role-guard first use) |
| `GET /admin/ci/insights`                                           | GET-admin   | 500    | Postgres connect (client-pool.ts:73 via database-role-guard first use) |
| `PUT /admin/ci/insights/:id`                                       | WRITE-empty | 500    | Postgres connect (client-pool.ts:73 via database-role-guard first use) |
| `GET /admin/customers`                                             | GET-admin   | 500    | Postgres connect (client-pool.ts:73 via database-role-guard first use) |
| `GET /admin/dashboard`                                             | GET-admin   | 500    | Postgres connect (client-pool.ts:73 via database-role-guard first use) |
| `POST /admin/email-queue/corrupt/discard`                          | WRITE-empty | 500    | Postgres connect (client-pool.ts:73 via database-role-guard first use) |
| `GET /admin/email-queue/failed`                                    | GET-admin   | 500    | Postgres connect (client-pool.ts:73 via database-role-guard first use) |
| `POST /admin/email-queue/failed/retry`                             | WRITE-empty | 500    | Postgres connect (client-pool.ts:73 via database-role-guard first use) |
| `GET /admin/export/orders`                                         | GET-admin   | 500    | Postgres connect (client-pool.ts:73 via database-role-guard first use) |
| `GET /admin/export/orders.xlsx`                                    | GET-admin   | 500    | Postgres connect (client-pool.ts:73 via database-role-guard first use) |
| `GET /admin/fiscal-archive`                                        | GET-admin   | 500    | Postgres connect (client-pool.ts:73 via database-role-guard first use) |
| `GET /admin/fiscal-archive/:storeId`                               | GET-admin   | 500    | Postgres connect (client-pool.ts:73 via database-role-guard first use) |
| `GET /admin/fiscal-archive/:storeId/:docId/html`                   | GET-admin   | 500    | Postgres connect (client-pool.ts:73 via database-role-guard first use) |
| `POST /admin/images/backfill-variants`                             | WRITE-empty | 500    | Postgres connect (client-pool.ts:73 via database-role-guard first use) |
| `POST /admin/impersonate`                                          | WRITE-empty | 500    | Postgres connect (client-pool.ts:73 via database-role-guard first use) |
| `GET /admin/notifications/onesignal/config`                        | GET-admin   | 500    | Postgres connect (client-pool.ts:73 via database-role-guard first use) |
| `GET /admin/notifications/onesignal/devices`                       | GET-admin   | 500    | Postgres connect (client-pool.ts:73 via database-role-guard first use) |
| `DELETE /admin/notifications/onesignal/devices/:playerId`          | WRITE-empty | 500    | Postgres connect (client-pool.ts:73 via database-role-guard first use) |
| `POST /admin/notifications/onesignal/subscribe`                    | WRITE-empty | 500    | Postgres connect (client-pool.ts:73 via database-role-guard first use) |
| `GET /admin/orders`                                                | GET-admin   | 500    | Postgres connect (client-pool.ts:73 via database-role-guard first use) |
| `GET /admin/products`                                              | GET-admin   | 500    | Postgres connect (client-pool.ts:73 via database-role-guard first use) |
| `GET /admin/products/:id`                                          | GET-admin   | 500    | Postgres connect (client-pool.ts:73 via database-role-guard first use) |
| `POST /admin/sms-queue/corrupt/discard`                            | WRITE-empty | 500    | Postgres connect (client-pool.ts:73 via database-role-guard first use) |
| `GET /admin/sms-queue/failed`                                      | GET-admin   | 500    | Postgres connect (client-pool.ts:73 via database-role-guard first use) |
| `POST /admin/sms-queue/failed/retry`                               | WRITE-empty | 500    | Postgres connect (client-pool.ts:73 via database-role-guard first use) |
| `GET /admin/stores`                                                | GET-admin   | 500    | Postgres connect (client-pool.ts:73 via database-role-guard first use) |
| `POST /admin/stores`                                               | WRITE-empty | 500    | Postgres connect (client-pool.ts:73 via database-role-guard first use) |
| `GET /admin/stores/:id`                                            | GET-admin   | 500    | Postgres connect (client-pool.ts:73 via database-role-guard first use) |
| `PUT /admin/stores/:id`                                            | WRITE-empty | 500    | Postgres connect (client-pool.ts:73 via database-role-guard first use) |
| `GET /admin/stores/:id/features`                                   | GET-admin   | 500    | Postgres connect (client-pool.ts:73 via database-role-guard first use) |
| `DELETE /admin/stores/:id/features`                                | WRITE-empty | 500    | Postgres connect (client-pool.ts:73 via database-role-guard first use) |
| `PUT /admin/stores/:id/features`                                   | WRITE-empty | 500    | Postgres connect (client-pool.ts:73 via database-role-guard first use) |
| `DELETE /admin/stores/:id/features/:featureKey`                    | WRITE-empty | 500    | Postgres connect (client-pool.ts:73 via database-role-guard first use) |
| `PUT /admin/stores/:id/features/:featureKey`                       | WRITE-empty | 500    | Postgres connect (client-pool.ts:73 via database-role-guard first use) |
| `POST /admin/stores/:id/manual-payment`                            | WRITE-empty | 500    | Postgres connect (client-pool.ts:73 via database-role-guard first use) |
| `GET /admin/stores/:id/manual-payment/suggest`                     | GET-admin   | 500    | Postgres connect (client-pool.ts:73 via database-role-guard first use) |
| `PUT /admin/stores/:id/plan`                                       | WRITE-empty | 500    | Postgres connect (client-pool.ts:73 via database-role-guard first use) |
| `PATCH /admin/stores/:id/status`                                   | WRITE-empty | 500    | Postgres connect (client-pool.ts:73 via database-role-guard first use) |
| `PUT /admin/stores/:id/subscription`                               | WRITE-empty | 500    | Postgres connect (client-pool.ts:73 via database-role-guard first use) |
| `GET /admin/stores/:storeId/builder/pages/:pageKey`                | GET-admin   | 500    | Postgres connect (client-pool.ts:73 via database-role-guard first use) |
| `PUT /admin/stores/:storeId/builder/pages/:pageKey/draft`          | WRITE-empty | 500    | Postgres connect (client-pool.ts:73 via database-role-guard first use) |
| `POST /admin/stores/:storeId/builder/pages/:pageKey/preview-token` | WRITE-empty | 500    | Postgres connect (client-pool.ts:73 via database-role-guard first use) |
| `POST /admin/stores/:storeId/builder/pages/:pageKey/publish`       | WRITE-empty | 500    | Postgres connect (client-pool.ts:73 via database-role-guard first use) |
| `GET /admin/stores/:storeId/builder/pages/:pageKey/revisions`      | GET-admin   | 500    | Postgres connect (client-pool.ts:73 via database-role-guard first use) |
| `POST /admin/stores/:storeId/builder/pages/:pageKey/rollback`      | WRITE-empty | 500    | Postgres connect (client-pool.ts:73 via database-role-guard first use) |
| `GET /admin/stores/:storeId/layout/`                               | GET-admin   | 500    | Postgres connect (client-pool.ts:73 via database-role-guard first use) |
| `PUT /admin/stores/:storeId/layout/`                               | WRITE-empty | 500    | Postgres connect (client-pool.ts:73 via database-role-guard first use) |
| `POST /admin/stores/:storeId/push/broadcast`                       | WRITE-empty | 500    | Postgres connect (client-pool.ts:73 via database-role-guard first use) |
| `GET /admin/stores/:storeId/push/broadcasts`                       | GET-admin   | 500    | Postgres connect (client-pool.ts:73 via database-role-guard first use) |
| `GET /admin/super-admin/ai-usage/summary`                          | GET-admin   | 500    | Postgres connect (client-pool.ts:73 via database-role-guard first use) |
| `GET /admin/super-admin/usage-history`                             | GET-admin   | 500    | Postgres connect (client-pool.ts:73 via database-role-guard first use) |
| `GET /admin/users`                                                 | GET-admin   | 500    | Postgres connect (client-pool.ts:73 via database-role-guard first use) |
| `POST /admin/users`                                                | WRITE-empty | 500    | Postgres connect (client-pool.ts:73 via database-role-guard first use) |
| `GET /admin/users/:id`                                             | GET-admin   | 500    | Postgres connect (client-pool.ts:73 via database-role-guard first use) |
| `DELETE /admin/users/:id`                                          | WRITE-empty | 500    | Postgres connect (client-pool.ts:73 via database-role-guard first use) |
| `PUT /admin/users/:id`                                             | WRITE-empty | 500    | Postgres connect (client-pool.ts:73 via database-role-guard first use) |
| `GET /admin/users/:userId/legal-acceptances`                       | GET-admin   | 500    | Postgres connect (client-pool.ts:73 via database-role-guard first use) |

## #415 / #407 family exists; route still reads Postgres (N-10d) (42 routes)

| Route                                                             | Group        | Status | Cause                                                                  |
| ----------------------------------------------------------------- | ------------ | ------ | ---------------------------------------------------------------------- |
| `GET /admin/billing/claims`                                       | GET-admin    | 500    | Postgres connect (client-pool.ts:73 via database-role-guard first use) |
| `GET /admin/billing/claims/:id/receipt`                           | GET-admin    | 500    | Postgres connect (client-pool.ts:73 via database-role-guard first use) |
| `POST /admin/billing/claims/:id/reject`                           | WRITE-empty  | 500    | Postgres connect (client-pool.ts:73 via database-role-guard first use) |
| `GET /admin/billing/events`                                       | GET-admin    | 500    | Postgres connect (client-pool.ts:73 via database-role-guard first use) |
| `POST /admin/billing/events/:id/manual-refund`                    | WRITE-empty  | 500    | Postgres connect (client-pool.ts:73 via database-role-guard first use) |
| `POST /admin/billing/events/:id/refund`                           | WRITE-empty  | 500    | Postgres connect (client-pool.ts:73 via database-role-guard first use) |
| `GET /admin/billing/grants`                                       | GET-admin    | 500    | Postgres connect (client-pool.ts:73 via database-role-guard first use) |
| `GET /admin/billing/subscriptions`                                | GET-admin    | 500    | Postgres connect (client-pool.ts:73 via database-role-guard first use) |
| `GET /admin/legal-policies`                                       | GET-admin    | 500    | Postgres connect (client-pool.ts:73 via database-role-guard first use) |
| `POST /admin/legal-policies/:docKey/:version/resume`              | WRITE-empty  | 500    | Postgres connect (client-pool.ts:73 via database-role-guard first use) |
| `POST /admin/legal-policies/:docKey/:version/retry-failed`        | WRITE-empty  | 500    | Postgres connect (client-pool.ts:73 via database-role-guard first use) |
| `POST /admin/legal-policies/:docKey/:version/send-notice`         | WRITE-empty  | 500    | Postgres connect (client-pool.ts:73 via database-role-guard first use) |
| `GET /admin/plans`                                                | GET-admin    | 500    | Postgres connect (client-pool.ts:73 via database-role-guard first use) |
| `PUT /admin/plans/:code`                                          | WRITE-empty  | 500    | Postgres connect (client-pool.ts:73 via database-role-guard first use) |
| `GET /admin/platform-vat`                                         | GET-admin    | 500    | Postgres connect (client-pool.ts:73 via database-role-guard first use) |
| `PUT /admin/platform-vat`                                         | WRITE-empty  | 500    | Postgres connect (client-pool.ts:73 via database-role-guard first use) |
| `GET /admin/provider-activation`                                  | GET-admin    | 500    | Postgres connect (client-pool.ts:73 via database-role-guard first use) |
| `POST /admin/provider-activation/:storeId/:provider/activate`     | WRITE-empty  | 500    | Postgres connect (client-pool.ts:73 via database-role-guard first use) |
| `POST /admin/provider-activation/:storeId/:provider/reject`       | WRITE-empty  | 500    | Postgres connect (client-pool.ts:73 via database-role-guard first use) |
| `POST /admin/provider-activation/:storeId/:provider/test`         | WRITE-empty  | 500    | Postgres connect (client-pool.ts:73 via database-role-guard first use) |
| `GET /admin/provider-verification`                                | GET-admin    | 500    | Postgres connect (client-pool.ts:73 via database-role-guard first use) |
| `POST /admin/provider-verification/:provider/confirm`             | WRITE-empty  | 500    | Postgres connect (client-pool.ts:73 via database-role-guard first use) |
| `GET /admin/tax-verification`                                     | GET-admin    | 500    | Postgres connect (client-pool.ts:73 via database-role-guard first use) |
| `GET /admin/tax-verification/:storeId`                            | GET-admin    | 500    | Postgres connect (client-pool.ts:73 via database-role-guard first use) |
| `POST /admin/tax-verification/:storeId/decision`                  | WRITE-empty  | 500    | Postgres connect (client-pool.ts:73 via database-role-guard first use) |
| `GET /admin/tax-verification/:storeId/documents/:documentId/file` | GET-admin    | 500    | Postgres connect (client-pool.ts:73 via database-role-guard first use) |
| `GET /admin/webhook-events`                                       | GET-admin    | 500    | Postgres connect (client-pool.ts:73 via database-role-guard first use) |
| `POST /admin/webhook-events/:id/replay`                           | WRITE-empty  | 500    | Postgres connect (client-pool.ts:73 via database-role-guard first use) |
| `GET /me/legal-acceptances/`                                      | GET-merchant | 500    | Postgres connect (client-pool.ts:73 via database-role-guard first use) |
| `GET /me/legal-notices/`                                          | GET-merchant | 500    | Postgres connect (client-pool.ts:73 via database-role-guard first use) |
| `GET /payment-settings/store/:storeId`                            | GET-merchant | 500    | Postgres connect (client-pool.ts:73 via database-role-guard first use) |
| `DELETE /payment-settings/store/:storeId/:provider`               | WRITE-empty  | 500    | Postgres connect (client-pool.ts:73 via database-role-guard first use) |
| `PUT /payment-settings/store/:storeId/:provider`                  | WRITE-empty  | 500    | Postgres connect (client-pool.ts:73 via database-role-guard first use) |
| `POST /payment-settings/store/:storeId/:provider/test`            | WRITE-empty  | 500    | Postgres connect (client-pool.ts:73 via database-role-guard first use) |
| `POST /payment-settings/store/:storeId/:provider/toggle`          | WRITE-empty  | 500    | Postgres connect (client-pool.ts:73 via database-role-guard first use) |
| `GET /stores/:storeId/billing/`                                   | GET-merchant | 500    | Postgres connect (client-pool.ts:73 via database-role-guard first use) |
| `POST /stores/:storeId/billing/cancel`                            | WRITE-empty  | 500    | Postgres connect (client-pool.ts:73 via database-role-guard first use) |
| `POST /stores/:storeId/billing/card-setup`                        | WRITE-empty  | 500    | Postgres connect (client-pool.ts:73 via database-role-guard first use) |
| `GET /stores/:storeId/billing/payment-claims`                     | GET-merchant | 500    | Postgres connect (client-pool.ts:73 via database-role-guard first use) |
| `GET /stores/:storeId/billing/receipts/:receiptId`                | GET-merchant | 500    | Postgres connect (client-pool.ts:73 via database-role-guard first use) |
| `GET /stores/:storeId/slug-redirects`                             | GET-merchant | 500    | Postgres connect (client-pool.ts:73 via database-role-guard first use) |
| `DELETE /stores/:storeId/slug-redirects/:id`                      | WRITE-empty  | 500    | Postgres connect (client-pool.ts:73 via database-role-guard first use) |

## #413 storefront (N-3/N-4) (9 routes)

| Route                                             | Group        | Status | Cause                                                                  |
| ------------------------------------------------- | ------------ | ------ | ---------------------------------------------------------------------- |
| `GET /public/:storeId/loyalty/info`               | GET-public   | 500    | Postgres connect (client-pool.ts:73 via database-role-guard first use) |
| `GET /public/:storeId/wishlist/:userId`           | GET-public   | 500    | Postgres connect (client-pool.ts:73 via database-role-guard first use) |
| `GET /public/customers/me/reorder`                | GET-customer | 500    | Postgres connect (client-pool.ts:73 via database-role-guard first use) |
| `GET /public/health`                              | GET-public   | 503    | ? @ ?                                                                  |
| `GET /public/stores`                              | GET-public   | 500    | Postgres connect (client-pool.ts:73 via database-role-guard first use) |
| `GET /stores/public/:storeId/manifest.json`       | GET-public   | 500    | Postgres connect (client-pool.ts:73 via database-role-guard first use) |
| `GET /stores/public/:storeId/pwa/config`          | GET-public   | 500    | Postgres connect (client-pool.ts:73 via database-role-guard first use) |
| `GET /stores/public/:storeId/shipping`            | GET-public   | 500    | Postgres connect (client-pool.ts:73 via database-role-guard first use) |
| `GET /stores/public/:storeId/shipping/area-rates` | GET-public   | 500    | Postgres connect (client-pool.ts:73 via database-role-guard first use) |

## #416 (9 routes)

| Route | Group | Status | Cause |
| ----- | ----- | ------ | ----- |

## #413 (N-4) plus unowned 400-as-500 (Session ID required) (7 routes)

| Route                                           | Group        | Status | Cause                                                   |
| ----------------------------------------------- | ------------ | ------ | ------------------------------------------------------- |
| `GET /stores/:storeId/cart/`                    | GET-merchant | 500    | Session ID required @ packages/database/src/index.ts:74 |
| `DELETE /stores/:storeId/cart/`                 | WRITE-empty  | 500    | Session ID required @ packages/database/src/index.ts:74 |
| `POST /stores/:storeId/cart/acknowledge-prices` | WRITE-empty  | 500    | Session ID required @ packages/database/src/index.ts:74 |
| `POST /stores/:storeId/cart/items`              | WRITE-empty  | 500    | Session ID required @ packages/database/src/index.ts:74 |
| `DELETE /stores/:storeId/cart/items/:itemId`    | WRITE-empty  | 500    | Session ID required @ packages/database/src/index.ts:74 |
| `PUT /stores/:storeId/cart/items/:itemId`       | WRITE-empty  | 500    | Session ID required @ packages/database/src/index.ts:74 |
| `POST /stores/:storeId/cart/sync`               | WRITE-empty  | 500    | Session ID required @ packages/database/src/index.ts:74 |

## unowned (shipping / alerts webhooks) (2 routes)

| Route                                                                      | Group   | Status | Cause                                   |
| -------------------------------------------------------------------------- | ------- | ------ | --------------------------------------- |
| `POST /alerts/webhooks/sentry`                                             | WEBHOOK | 503    | Alerts webhook token is not configured. |
| `POST /webhooks/shipping/bosta/e778c3ce-71f5-458e-b126-9ed07032fa2d/sweep` | WEBHOOK | 500    | Internal Server Error                   |

## #414 / N-8 identity (passkeys) (1 routes)

| Route                 | Group        | Status | Cause                                                                  |
| --------------------- | ------------ | ------ | ---------------------------------------------------------------------- |
| `GET /auth/passkeys/` | GET-merchant | 500    | Postgres connect (client-pool.ts:73 via database-role-guard first use) |

## #414 (customer auth DO) [login of a DO customer] (1 routes)

| Route              | Group | Status | Cause                                                                  |
| ------------------ | ----- | ------ | ---------------------------------------------------------------------- |
| `POST /auth/login` | FLOW  | 500    | Postgres connect (client-pool.ts:73 via database-role-guard first use) |

## Non-Postgres findings

- `Session ID required` is thrown as a plain `Error` with `statusCode: 400` (`routes/cart.routes.ts` `getSessionId`, `routes/order.routes.ts:554`); the error handler answers **500**, not 400 (8 requests). Owner: unowned (not NEON-ZERO). Fix: throw `AppError(400, ...)`.
- `POST /stores/:storeId/products` with `inventory: 10` is a 500 (Postgres) while the same body without `inventory` is 201; the inventory write is not DO-routed. Consequence: the storefront flow cannot be driven past `cart/items` (an inventory-less product answers 400 `INSUFFICIENT_INVENTORY`), so `POST /public/orders/quote` and `POST /public/orders` are only measured as `EMPTY_CART` 400. Owner: unowned (N-11 inventory); N-4b (`quote` -> `getEntitlements`) is still open too.
- `POST /alerts/webhooks/sentry` answers 503 `alerts_not_configured` because the test Worker has no `ALERTS_WEBHOOK_TOKEN`; that is configuration, not Postgres.
- Cron: the five cron expressions below were run against a DO store; job outcomes come from the Worker's `[cron] job done|failed` lines.

| Cron           | Job                       | Outcome | Owner                                                                                   |
| -------------- | ------------------------- | ------- | --------------------------------------------------------------------------------------- |
| `0 * * * *`    | store-schedule-sync       | done    |                                                                                         |
| `0 * * * *`    | store-directory-reconcile | failed  | unowned (N-22 hotfix job: reads the Postgres Store table by design until N-16/N-17)     |
| `*/15 * * * *` | billing-deferred-webhooks | done    |                                                                                         |
| `*/15 * * * *` | abandoned-cart            | done    |                                                                                         |
| `*/30 * * * *` | shipping-tracking         | failed  | unowned (N-11 shipping)                                                                 |
| `0 */12 * * *` | refresh-token-cleanup     | failed  | #414 (RefreshToken of a DO customer lives in the DO; the cleanup still sweeps Postgres) |
| `0 3 * * *`    | backup-sweep              | failed  | unowned (G8 backup sweep lists stores from Postgres)                                    |
| `0 3 * * *`    | loyalty-daily             | done    |                                                                                         |

Jobs started by `runScheduledJobs` (inngest-style groups) log through the jobs queue, not `[cron]`; they were not separately observable in this harness (ran: yes, outcome: not captured). Owner for any failure there: #416.
