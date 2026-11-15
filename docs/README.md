# Docs index

Single index of everything under `docs/`. One line per doc, grouped by area. Rulings: [rulings/README.md](rulings/README.md) (one file per ruling; the folder is the index, no table). Rules and invariants live in the repo-root `CLAUDE.md`; sizing baselines in the repo-root `design.md`.

`tests/unit/docs-index.test.ts` fails when a doc under `docs/` is missing from this page.

## Rulings

- [Rulings index](rulings/README.md) - one file per ruling in `docs/rulings/`; add a ruling by adding its file only (no table row, no count). The old `RULINGS.md` is a pointer to it.

## Top level - Operations and platform references

- [CHANGELOG-2026-10-16-ahmad-decisions.md](CHANGELOG-2026-10-16-ahmad-decisions.md) - Changelog — Ahmad's 2026-10-16 decisions (branch `fix/ahmad-decisions-1016`)
- [CHANGELOG-2026-10-16-followups-b0-46.md](CHANGELOG-2026-10-16-followups-b0-46.md) - Changelog — B0-46 follow-up fixes (branch `fix/followups-b0-46`)
- [CHANGELOG-2026-11-04-admin-fix-t2-api-domain.md](CHANGELOG-2026-11-04-admin-fix-t2-api-domain.md) - Admin fix pass, T2 (API domain), 2026-11-04
- [CHANGELOG-2026-11-04-admin-fix-pass-t3.md](CHANGELOG-2026-11-04-admin-fix-pass-t3.md) - Admin fix pass, T3 UI foundation (2026-11-04)
- [CHANGELOG-2026-11-04-admin-fix-pass-t4.md](CHANGELOG-2026-11-04-admin-fix-pass-t4.md) - Admin fix pass, T4 store setup pages (2026-11-04)
- [CHANGELOG-2026-11-04-admin-fix-pass-t6.md](CHANGELOG-2026-11-04-admin-fix-pass-t6.md) - Admin fix pass, T6 stock / finance / insights / platform / onboarding (2026-11-04)
- [CHANGELOG-2026-11-09-admin-audit-closure-ux.md](CHANGELOG-2026-11-09-admin-audit-closure-ux.md) - Admin audit closure, UX rows (2026-11-09)
- [admin-routes-triage-2026-11-11.md](admin-routes-triage-2026-11-11.md) - Triage of the 89 routes with no admin caller (F-9-prune)
- [CHANGELOG-2026-11-09-admin-audit-closure-p2-api-web.md](CHANGELOG-2026-11-09-admin-audit-closure-p2-api-web.md) - Admin audit closure, API and storefront rows (2026-11-09)
- [CHANGELOG-2026-11-09-admin-audit-closure-p2-store-do.md](CHANGELOG-2026-11-09-admin-audit-closure-p2-store-do.md) - Atomic StoreDO settings patch (2026-11-09)
- [CHANGELOG-2026-11-04-admin-fix-pass-t5.md](CHANGELOG-2026-11-04-admin-fix-pass-t5.md) - Admin fix pass, T5 UI catalog + sales (2026-11-04)
- [DB-BACKUP-RESTORE.md](DB-BACKUP-RESTORE.md) - Database backup, restore & disaster recovery
- [DB-INDEX-MIGRATIONS.md](DB-INDEX-MIGRATIONS.md) - DB index migrations — lock procedure
- [DEPLOYMENT.md](DEPLOYMENT.md) - Ebda Store - Production Deployment Guide
- [ENVIRONMENT.md](ENVIRONMENT.md) - Environment variables — all apps
- [HANDOFF-2026-06-01.md](HANDOFF-2026-06-01.md) - Ebda AI Studio — Session Handoff (2026-05-29 → 2026-06-01)
- [INCIDENT.md](INCIDENT.md) - Incident Response — Ebda Store
- [load-testing.md](load-testing.md) - Load testing (k6 on GitHub-hosted runners)
- [NOTIFICATION-CHANNELS.md](NOTIFICATION-CHANNELS.md) - Order notification channels and alert classes
- [RETENTION.md](RETENTION.md) - Data retention policy
- [ROLLBACK.md](ROLLBACK.md) - Production rollback — Ebda
- [RULINGS.md](RULINGS.md) - Rulings ledger (moved)
- [SCALING.md](SCALING.md) - Horizontal Scaling Guide — Ebda Store API

## admin - Admin app standards

- [admin/ACTION-PLACEMENT-STANDARD.md](admin/ACTION-PLACEMENT-STANDARD.md) - Admin action-placement standard

## adr - Architecture decision records

- [adr/0001-ebda-tenant-isolation.md](adr/0001-ebda-tenant-isolation.md) - ADR 0001 — Ebda Store tenant isolation: Postgres Row-Level Security

## api - API references

- [api/auth-impersonation-and-error-contract.md](api/auth-impersonation-and-error-contract.md) - Auth, impersonation, error bodies and Server-Timing (API contract)
- [api/b2b-wholesale.md](api/b2b-wholesale.md) - B2B wholesale pricing API
- [api/loyalty.md](api/loyalty.md) - Loyalty API (admin and storefront)
- [api/lifecycle-emails.md](api/lifecycle-emails.md) - Lifecycle emails (self-serve onboarding)
- [api/openapi.yaml](api/openapi.yaml) - openapi
- [api/route-inventory.md](api/route-inventory.md) - Generated inventory of every Express route (method, path, auth chain, feature and permission gates)
- [api/studio-enquiry.md](api/studio-enquiry.md) - Studio service-enquiry form (contact page, mail-only)

## architecture - Architecture and invariants

- [architecture/admin-csp.md](architecture/admin-csp.md) - Admin and Orders CSP: nonce + strict-dynamic (SEC-4)
- [architecture/admin-search.md](architecture/admin-search.md) - Admin search (⌘K palette, Settings search box)
- [architecture/cf-schema.md](architecture/cf-schema.md) - Cloudflare schema (`packages/cf-schema`)
- [architecture/email-rendering.md](architecture/email-rendering.md) - Transactional email rendering
- [architecture/gold-rate-pricing.md](architecture/gold-rate-pricing.md) - Gold-rate pricing (Phase B5)
- [architecture/inngest-execution-budget.md](architecture/inngest-execution-budget.md) - Inngest execution budget
- [architecture/inventory-model.md](architecture/inventory-model.md) - Inventory model — where a product's stock actually lives
- [architecture/merchant-mcp.md](architecture/merchant-mcp.md) - Merchant-admin MCP surface
- [architecture/page-definition.md](architecture/page-definition.md) - PageDefinition — the visual builder's page document
- [architecture/request-transaction-lifecycle.md](architecture/request-transaction-lifecycle.md) - Request transaction lifecycle (tenantContext, identity pre-check, Server-Timing)
- [architecture/security-contracts.md](architecture/security-contracts.md) - Security Contracts
- [architecture/slug-redirects.md](architecture/slug-redirects.md) - Slug redirects
- [architecture/sticky-overflow-follow-up.md](architecture/sticky-overflow-follow-up.md) - Follow-up: `position: sticky` is inert storefront-wide
- [architecture/store-checkout-settings.md](architecture/store-checkout-settings.md) - Per-store checkout & order settings (`Store.settings` JSON)
- [architecture/store-theme-flags.md](architecture/store-theme-flags.md) - Per-store visual configuration — flags, owners, invariants
- [architecture/storefront-csp.md](architecture/storefront-csp.md) - Storefront CSP — why `script-src 'unsafe-inline'` stays
- [architecture/visual-editor.md](architecture/visual-editor.md) - Visual editor (canvas-first)

## audits - Audit reports

- [audits/2026-05-28-feature-enforcement-coverage.md](audits/2026-05-28-feature-enforcement-coverage.md) - Feature Flag Enforcement Coverage Audit — 2026-05-28
- [audits/2026-05-28-feature-flag-enforcement.md](audits/2026-05-28-feature-flag-enforcement.md) - Feature Flag Enforcement Audit — 2026-05-28
- [audits/2026-05-28-lifecycle-event-coverage.md](audits/2026-05-28-lifecycle-event-coverage.md) - Lifecycle Event Coverage Audit
- [audits/2026-05-28-page-builder-save-audit.md](audits/2026-05-28-page-builder-save-audit.md) - Page-Builder Save Audit — 2026-05-28
- [audits/2026-06-09-rls-async-writer-audit.md](audits/2026-06-09-rls-async-writer-audit.md) - RLS async-writer audit — 2026-06-09
- [audits/2026-07-02-scaling-perf.md](audits/2026-07-02-scaling-perf.md) - Ebda Store Scaling & Performance Audit — 2026-07-02
- [audits/2026-07-02-tenancy-rls-auth.md](audits/2026-07-02-tenancy-rls-auth.md) - Tenancy / RLS / Auth deep audit — 2026-07-02
- [audits/2026-07-12-scaling-cliff-reel.md](audits/2026-07-12-scaling-cliff-reel.md) - Ebda Store Scaling-Cliff Audit — 2026-07-12
- [audits/2026-07-13-cache-stampede.md](audits/2026-07-13-cache-stampede.md) - Ebda Store — Cache Stampede Audit
- [audits/2026-07-15-rls-enforcement-audit.md](audits/2026-07-15-rls-enforcement-audit.md) - RLS enforcement audit — 2026-07-15
- [audits/2026-07-15-rls-transaction-timeout-class.md](audits/2026-07-15-rls-transaction-timeout-class.md) - RLS request-transaction 30s-budget audit — 2026-07-15
- [audits/2026-07-15-security-readiness-enterprise-procurement.md](audits/2026-07-15-security-readiness-enterprise-procurement.md) - Security-Readiness Audit — Enterprise Procurement Lens (2026-07-15)
- [audits/2026-07-16-rls-cutover-readiness-map.md](audits/2026-07-16-rls-cutover-readiness-map.md) - RLS Cutover Readiness Map — the earlier app role flip, line-by-line safety foundation (2026-07-16)
- [audits/2026-07-17-error-message-ux-audit.md](audits/2026-07-17-error-message-ux-audit.md) - Error-message UX audit (storefront) — 2026-07-17
- [audits/2026-07-31-vibecoded-security-holes.md](audits/2026-07-31-vibecoded-security-holes.md) - Ebda Store audit — "10 security holes in almost every vibecoded app"
- [audits/2026-08-08-reel-lens-audit.md](audits/2026-08-08-reel-lens-audit.md) - Audit — the 5 new foundation lenses (21–25) against Ebda Store · 2026-08-08
- [audits/2026-08-30-variant-stock-drift.md](audits/2026-08-30-variant-stock-drift.md) - Audit — variant stock drift (2026-08-30)
- [audits/2026-08-31-reel-derived-lenses.md](audits/2026-08-31-reel-derived-lenses.md) - Reel-derived lens audit — 2026-08-31
- [audits/2026-09-02-adversarial-audit.md](audits/2026-09-02-adversarial-audit.md) - Adversarial audit — ebda-store, 2026-09-02
- [audits/2026-10-14-marketing-levelup-review.md](audits/2026-10-14-marketing-levelup-review.md) - ebda.app: level-up review and 3D replacement
- [audits/\_slices/2026-09-02-adversarial/injection-render.md](audits/_slices/2026-09-02-adversarial/injection-render.md) - Adversarial audit — dimension: injection-render (untrusted input → dangerous sink)
- [audits/\_slices/2026-09-02-adversarial/tenant-isolation.md](audits/_slices/2026-09-02-adversarial/tenant-isolation.md) - Adversarial audit — Cross-tenant isolation (slug: `tenant-isolation`)

## business - Business papers

- [business/plan-feature-matrix.md](business/plan-feature-matrix.md) - Ebda Store — Plan ⇄ Feature Matrix

## cf - Cloudflare migration material

- [cf/fn-map.json](cf/fn-map.json) - fn map
- [cf/jobs-map.md](cf/jobs-map.md) - Background jobs on Cloudflare (G5)
- [cf/jobs-on-do.md](cf/jobs-on-do.md) - Jobs on the store Durable Object and the write freeze (INFRA-CF-1 PR E)
- [cf/neon-zero-integration.md](cf/neon-zero-integration.md) - NEON-ZERO integration branch: every merge conflict between the twelve PRs and its resolution
- [cf/neon-zero-final-classification.md](cf/neon-zero-final-classification.md) - every file that can still reach the removed Postgres, classified reachable-broken / routed-ok / unreachable (2026-11-10)
- [cf/neon-zero-remaining.md](cf/neon-zero-remaining.md) - NEON-ZERO route sweep with Postgres dead: routes still failing, by owner PR
- [cf/jobs-postgres-removed-sweep.md](cf/jobs-postgres-removed-sweep.md) - background jobs vs the removed Postgres: every job call path classified (ported / unreachable / fails) with fixes
- [cf/neon-zero-routes-b.md](cf/neon-zero-routes-b.md) - NEON-ZERO routes group B (per-store admin): sweep before/after and what is left
- [cf/orders-on-do.md](cf/orders-on-do.md) - Orders on the store Durable Object: create, confirm, cancel, expire hold (INFRA-CF-1 PR D2b-2)
- [cf/loyalty-do-migration.md](cf/loyalty-do-migration.md) - Loyalty on Durable Object stores: one-off ledger migration (Ruling FP-2)
- [runbooks/customer-auth-cutover.md](runbooks/customer-auth-cutover.md) - Customer auth cutover to the store Durable Object: copy, verify, flip (N-9)
- [cf/default-category-backfill.md](cf/default-category-backfill.md) - Default category Arabic name: backfill for DO stores
- [cf/opus-review-closure.md](cf/opus-review-closure.md) - Opus review of #356 closed item by item with the proving test and its result, the leftovers closed, and the merge point for feat/cf-r6b (INFRA-CF-1)
- [cf/r6a-on-do.md](cf/r6a-on-do.md) - The last three Postgres-only flows on the store Durable Object: palette search, campaigns, shopper erasure; InstaPay receipts at cutover (INFRA-CF-1 PR R6a)
- [cf/payments-on-do.md](cf/payments-on-do.md) - Payments, webhooks, refunds, ledger and gold repricing on the store Durable Object (INFRA-CF-1 PR D2b-3)
- [cf/returns-on-do.md](cf/returns-on-do.md) - The Return lifecycle and the partial-return journal on the store Durable Object (INFRA-CF-1 R1)
- [cf/not-on-do.json](cf/not-on-do.json) - The flip-gate inventory: every refusal and Postgres-only flow of a Durable Object store (INFRA-CF-1 PR D2b-4, `node scripts/cf/not-on-do.mjs`)
- [cf/repo-factory.md](cf/repo-factory.md) - Repo factory: reads on the store's backend (INFRA-CF-1 PR C, Ruling CF-REPO-1)

## contracts - Service and API contracts

- [contracts/identity-client-token-v1.3.example.json](contracts/identity-client-token-v1.3.example.json) - identity client token v1.3.example
- [contracts/identity-token-v1.2.example.json](contracts/identity-token-v1.2.example.json) - identity token v1.2.example

## decisions - Decision logs

- [decisions/2026-10-10-product-company-naming.md](decisions/2026-10-10-product-company-naming.md) - Product and company naming

## ebda - Ebda program: plans, research, brand, templates

- [ebda-assistant-rollout.md](ebda-assistant-rollout.md) - Ebda Store assistant: rollout stages and safety gate
- [ebda/ads-tracking.md](ebda/ads-tracking.md) - Ebda Store acquisition tracking (own Meta ads + PostHog funnel)
- [ebda/brand/ebda-brief-v2.html](ebda/brand/ebda-brief-v2.html) - ebda brief v2
- [ebda/brand/operator.md](ebda/brand/operator.md) - Operator of Ebda
- [ebda/builder-publish-regressions.md](ebda/builder-publish-regressions.md) - Builder publication regression evidence
- [ebda/business-gaps-2026-10.md](ebda/business-gaps-2026-10.md) - Ebda business gaps — draft for Ahmad (2026-10-10)
- [ebda/ci.md](ebda/ci.md) - Ebda CI: lean lanes and the minutes budget
- [ebda/dependency-security-baseline.md](ebda/dependency-security-baseline.md) - Dependency security baseline
- [ebda/design/cloudflare-backend-inventory.md](ebda/design/cloudflare-backend-inventory.md) - Ebda Store API -> Cloudflare Workers: backend inventory
- [ebda/design/cloudflare-backend.md](ebda/design/cloudflare-backend.md) - Ebda backend on Cloudflare: design (SP3, 2026-10-03)
- [ebda/design/express-on-workerd-experiment.md](ebda/design/express-on-workerd-experiment.md) - Experiment: can Ebda Store's existing Express API run on Cloudflare workerd?
- [ebda/design/ruling-draft-sp3.md](ebda/design/ruling-draft-sp3.md) - Ruling R-EBDA-001 — backend runtime (draft; moves into `docs/RULINGS.md` on `main` in SP4)
- [ebda/design/stage1-exit-test.md](ebda/design/stage1-exit-test.md) - SP4 Stage 1 exit test and status (2026-10-04)
- [ebda/design/stage2-parity.md](ebda/design/stage2-parity.md) - SP4 Stage 2: buy-flow parity, Node against Workers (2026-10-04)
- [ebda/design/stage2-workers-db.md](ebda/design/stage2-workers-db.md) - SP4 Stage 2: the database client on Workers, memory, burst and soak (2026-10-04)
- [ebda/evidence-hierarchy.md](ebda/evidence-hierarchy.md) - Ebda — evidence hierarchy (2026-10-10)
- [ebda/fix-item-triage-2026-10.md](ebda/fix-item-triage-2026-10.md) - FIX-001..016 triage — 2026-10-10
- [ebda/launch-readiness-2026-10-05.md](ebda/launch-readiness-2026-10-05.md) - Ebda launch readiness — 2026-10-05
- [ebda/plans/2026-10-03-ebda-program-plan.md](ebda/plans/2026-10-03-ebda-program-plan.md) - Ebda Program Plan — CLOUD-RUN EDITION (final, 2026-10-03)
- [ebda/plans/2026-10-03-sp10-research.md](ebda/plans/2026-10-03-sp10-research.md) - SP10 — Research plan (2026-10-03)
- [ebda/plans/2026-10-03-sp3-cloudflare-backend.md](ebda/plans/2026-10-03-sp3-cloudflare-backend.md) - SP3 — Cloudflare backend design + spike (task plan, 2026-10-03)
- [ebda/plans/2026-10-03-sp4-clone-rebrand.md](ebda/plans/2026-10-03-sp4-clone-rebrand.md) - SP4 — Clone, rebrand, Egypt base, hosts, backend Stage 1 (task plan, 2026-10-03)
- [ebda/plans/2026-10-03-sp5-self-serve-billing.md](ebda/plans/2026-10-03-sp5-self-serve-billing.md) - SP5 — Self-serve onboarding + merchant billing (task plan, 2026-10-03)
- [ebda/plans/2026-10-04-sp6-payments.md](ebda/plans/2026-10-04-sp6-payments.md) - SP6 — Payments layer (task plan, 2026-10-04)
- [ebda/plans/STATUS.md](ebda/plans/STATUS.md) - Ebda — status (updated 2026-10-04, all sub-projects built; remaining items need Ahmad)
- [ebda/plans/domains-and-marketing-site.md](ebda/plans/domains-and-marketing-site.md) - Ebda — domains and marketing site (Ahmad, 2026-10-03)
- [ebda/plans/pre-launch-plan.md](ebda/plans/pre-launch-plan.md) - Ebda (ابدأ) — pre-launch plan
- [ebda/plans/sp4-amelia-local-run.md](ebda/plans/sp4-amelia-local-run.md) - SP4 task 8: Amelia Aurum local run
- [ebda/plans/sp4-sp5-evidence.md](ebda/plans/sp4-sp5-evidence.md) - SP4 + SP5 closing evidence (2026-10-04)
- [ebda/plans/sp4-stores-rls-followup.md](ebda/plans/sp4-stores-rls-followup.md) - SP4 follow-up: strict RLS on `stores`
- [ebda/research/2026-10-24-provider-docs-reverify.md](ebda/research/2026-10-24-provider-docs-reverify.md) - Provider docs re-verification, 2026-10-24
- [ebda/research/README.md](ebda/research/README.md) - Ebda research (SP10, 2026-10-03)
- [ebda/research/egypt-payment-providers.md](ebda/research/egypt-payment-providers.md) - Egypt Payment Providers: Research Brief for Ebda
- [ebda/research/egypt-shipping-carriers.md](ebda/research/egypt-shipping-carriers.md) - Egypt Shipping Carriers: Research Brief for Ebda
- [ebda/research/pricing-and-packaging.md](ebda/research/pricing-and-packaging.md) - Ebda pricing and packaging research
- [ebda/research/whatsapp-cloud-api-egypt.md](ebda/research/whatsapp-cloud-api-egypt.md) - WhatsApp Cloud API for Ebda: Egypt pricing and platform notes
- [ebda/templates/2026-10-14-directions.md](ebda/templates/2026-10-14-directions.md) - Template directions — round 1 (2026-10-14)
- [ebda/templates/dahab.md](ebda/templates/dahab.md) - Dahab (دهب) — jewellery template (Phase B5)
- [ebda/templates/demo-store.md](ebda/templates/demo-store.md) - Demo store (looks showroom)
- [ebda/templates/editor-matrix.json](ebda/templates/editor-matrix.json) - editor matrix
- [ebda/templates/editor-matrix.md](ebda/templates/editor-matrix.md) - Editor control matrix
- [ebda/templates/jasmine.md](ebda/templates/jasmine.md) - Jasmine (ياسمين): the beauty and skincare template and its three looks
- [ebda/templates/lamma.md](ebda/templates/lamma.md) - Lamma (لمّة): the home food and home kitchen template and its three looks
- [ebda/templates/looks.md](ebda/templates/looks.md) - Looks
- [ebda/templates/platform-commerce.md](ebda/templates/platform-commerce.md) - Platform commerce features (Phase B0)
- [ebda/templates/purchase-path.json](ebda/templates/purchase-path.json) - purchase path
- [ebda/templates/qamar.md](ebda/templates/qamar.md) - Qamar (قمر): the fashion template and its three looks
- [ebda/templates/quality-bar.md](ebda/templates/quality-bar.md) - Template quality bar (binding for every template and every look)
- [ebda/templates/research/SUMMARY.md](ebda/templates/research/SUMMARY.md) - Cross-template platform feature ranking (2026-10-14)
- [ebda/templates/research/dahab.md](ebda/templates/research/dahab.md) - Dahab (jewellery, handmade & premium gifts) - reference research 2026-10-14
- [ebda/templates/research/jasmine.md](ebda/templates/research/jasmine.md) - Jasmine (beauty & skincare) - reference research 2026-10-14
- [ebda/templates/research/lamma.md](ebda/templates/research/lamma.md) - Lamma (home food & home kitchens) - reference research 2026-10-14
- [ebda/templates/research/qamar.md](ebda/templates/research/qamar.md) - Qamar (fashion & boutiques) - reference research 2026-10-14
- [ebda/templates/research/souq.md](ebda/templates/research/souq.md) - Souq (general retail & electronics) - reference research 2026-10-14
- [ebda/templates/souq.md](ebda/templates/souq.md) - Souq (سوق): the general retail and electronics template and its three looks
- [ebda/truth-table-2026-10.md](ebda/truth-table-2026-10.md) - Ebda truth table — 2026-10-10
- [ebda/ui/2026-10-05-merchant-ui-verification.md](ebda/ui/2026-10-05-merchant-ui-verification.md) - Ebda merchant UI — verification, 5 October 2026
- [ebda/ui/smooth-scroll-and-navigation.md](ebda/ui/smooth-scroll-and-navigation.md) - Smooth scrolling and page navigation: why the root html element carries data-scroll-behavior

## incidents - Incident write-ups

- [incidents/2026-10-23-array-buffer-and-tail.md](incidents/2026-10-23-array-buffer-and-tail.md) - Incident 2026-10-23: "Invalid array buffer length" + 20 s tail on ebda-api

## launch - Launch readiness

- [launch/marketing-assets-needed.md](launch/marketing-assets-needed.md) - Assets the marketing site still needs from Ahmad (marketing-levelup P2)
- [launch/support-page.md](launch/support-page.md) - The /support page (24/7, assistant first, a person for money and security), the home cost line and the 360px check (audit M-033, M-031, M-039)
- [launch/marketing-launch-checklist.md](launch/marketing-launch-checklist.md) - Marketing site: launch-day checklist (P12)

## legal - Legal

- [legal/VAT-0-clause.md](legal/VAT-0-clause.md) - VAT-0: the final clause (Ruling VAT-0, Ahmad 2026-10-26)

## merchant - Merchant-facing guides

- [merchant/README.md](merchant/README.md) - Ebda Store — Merchant Guide
- [merchant/custom-domain.md](merchant/custom-domain.md) - Custom Domain Setup — ربط النطاق المخصص
- [merchant/faq.md](merchant/faq.md) - FAQ — الأسئلة الشائعة
- [merchant/acceptable-use.md](merchant/acceptable-use.md) - What you may and may not sell / ما يجوز بيعه وما لا يجوز
- [merchant/gold-and-payments.md](merchant/gold-and-payments.md) - Gold orders and installments / طلبات الدهب والتقسيط
- [merchant/finance.md](merchant/finance.md) - Finance pages: profit and expenses, bank statements — صفحات المالية: الأرباح والمصروفات
- [merchant/inventory.md](merchant/inventory.md) - Inventory: variant stock, adjustments & scanning — المخزون: مخزون التنويعات والتعديلات والمسح
- [merchant/loyalty.md](merchant/loyalty.md) - Loyalty points
- [merchant/orders.md](merchant/orders.md) - Orders (and the Orders app) — الطلبات (وتطبيق الطلبات)
- [merchant/product-details.md](merchant/product-details.md) - Product details: swatches, facts, personalisation, delivery time and size guides — تفاصيل المنتج
- [merchant/provider-activation.md](merchant/provider-activation.md) - Connecting a payment or shipping service / ربط خدمة دفع أو شحن
- [merchant/quickstart.md](merchant/quickstart.md) - Quickstart — البدء السريع
- [merchant/shipping-areas.md](merchant/shipping-areas.md) - Delivery Areas & Fees — مناطق التوصيل والرسوم
- [merchant/troubleshooting.md](merchant/troubleshooting.md) - Troubleshooting — حل المشاكل

## migration - Migration guides

- [migration/backend-cf-migration-plan.md](migration/backend-cf-migration-plan.md) - Backend → Cloudflare migration plan (Ebda Store API + WBS)
- [migration/cf-opennext-hardening-plan.md](migration/cf-opennext-hardening-plan.md) - Cloudflare / OpenNext storefront hardening plan (2026-06-27)
- [migration/cloudflare-ci-deploy.md](migration/cloudflare-ci-deploy.md) - Cloudflare CI/CD — auto-deploy the Next apps as Workers
- [migration/cloudflare-cutover-runbook.md](migration/cloudflare-cutover-runbook.md) - Cloudflare cutover runbook — per-tenant frontend migration (Vercel → Cloudflare-for-SaaS)
- [migration/cloudflare-preview-workers.md](migration/cloudflare-preview-workers.md) - Cloudflare preview workers — Ebda Store frontends (OpenNext)
- [migration/cloudflare-readiness.md](migration/cloudflare-readiness.md) - Cloudflare migration readiness — Ebda AI Studio Vercel fleet
- [migration/europe-region-migration-runbook.md](migration/europe-region-migration-runbook.md) - Europe region migration runbook — Ebda Store + WBS → Frankfurt/Netherlands
- [migration/railway-actions-deploy.md](migration/railway-actions-deploy.md) - Railway API deploy → GitHub Actions (cutover)

## observability - Observability

- [observability/slo.md](observability/slo.md) - Service Level Objectives (SLOs) — Ebda Store

## ops - Operations

- [ops/escalation.md](ops/escalation.md) - Escalation: who is contacted for P0/P1, payment and data incidents, channels, response targets

## perf - Performance

- [perf/index-audit-2026-05.md](perf/index-audit-2026-05.md) - Index Audit — 2026-05-01
- [perf/index-audit-2026-08-fk-coverage.md](perf/index-audit-2026-08-fk-coverage.md) - Index Audit — 2026-08-08 — foreign-key coverage
- [perf/index-audit-2026-10.md](perf/index-audit-2026-10.md) - Index Audit — 2026-10-01
- [perf/loadtest-2026-05.md](perf/loadtest-2026-05.md) - Load Test Baseline — 2026-05-01
- [perf/schema-drift-2026-08-08.md](perf/schema-drift-2026-08-08.md) - Schema drift inventory — 2026-08-08

## plans - Implementation plans

- [plans/README.md](plans/README.md) - Plans index: status lives in the program register; docs/plans = open work, done/ = shipped
- [plans/done/2026-07-02-rls-cutover.md](plans/done/2026-07-02-rls-cutover.md) - RLS Cutover Plan — Option B (make the database backstop real)
- [plans/2026-07-03-ai-bulk-sweeps.md](plans/2026-07-03-ai-bulk-sweeps.md) - AI Bulk Sweeps — fix Product FAQs + add 4 new catalogue sweeps
- [plans/done/2026-07-04-hero-banner-link.md](plans/done/2026-07-04-hero-banner-link.md) - Hero banner links — make hero slides pressable (marketing space)
- [plans/done/2026-07-12-tenant-cacheable-routing.md](plans/done/2026-07-12-tenant-cacheable-routing.md) - Tenant-Cacheable Storefront Routing — Implementation Plan
- [plans/done/2026-07-20-refund-reversal-stuck-sweep.md](plans/done/2026-07-20-refund-reversal-stuck-sweep.md) - Refund-reversal stuck sweep — closing the silent stock-loss path
- [plans/done/2026-09-02-adversarial-audit-remediation.md](plans/done/2026-09-02-adversarial-audit-remediation.md) - Adversarial Audit Remediation — Implementation Plan
- [plans/done/2026-09-12-p2-backlog-remediation.md](plans/done/2026-09-12-p2-backlog-remediation.md) - P2 Audit-Backlog Remediation Plan
- [plans/done/2026-09-16-store-resolve-transient-not-404.md](plans/done/2026-09-16-store-resolve-transient-not-404.md) - A transient store-resolve failure must not tell a shopper the store does not exist
- [plans/done/2026-09-17-db-backup-assert-dump.md](plans/done/2026-09-17-db-backup-assert-dump.md) - Backup dumps are asserted, not just counted
- [plans/done/2026-09-25-customer-wallet.md](plans/done/2026-09-25-customer-wallet.md) - D1 — Customer Wallet (store credit)
- [plans/done/2026-09-25-email-campaigns.md](plans/done/2026-09-25-email-campaigns.md) - D2 — Email Campaigns (spec + plan)
- [plans/done/2026-10-05-ebda-launch-readiness.md](plans/done/2026-10-05-ebda-launch-readiness.md) - Ebda launch readiness
- [plans/done/2026-10-05-ebda-merchant-ui.md](plans/done/2026-10-05-ebda-merchant-ui.md) - Ebda merchant UI implementation plan
- [plans/done/2026-10-05-pricing-decisions.md](plans/done/2026-10-05-pricing-decisions.md) - Ebda pricing — locked 2026-10-05
- [plans/done/2026-10-05-pricing-implementation.md](plans/done/2026-10-05-pricing-implementation.md) - Locked pricing implementation plan
- [plans/done/2026-10-07-builder-file-plan.md](plans/done/2026-10-07-builder-file-plan.md) - Ebda visual builder — file-by-file plan, phases 1–5
- [plans/done/2026-10-07-builder-phase0-gap-matrix.md](plans/done/2026-10-07-builder-phase0-gap-matrix.md) - Ebda visual builder — Phase 0 gap matrix
- [plans/done/2026-10-07-builder-template-shortlist.md](plans/done/2026-10-07-builder-template-shortlist.md) - Ebda storefront template shortlist (Phase 0)
- [plans/done/2026-10-07-ebda-accounts-sso.md](plans/done/2026-10-07-ebda-accounts-sso.md) - Ebda Accounts — one login across store., whatsapp., crm.ebda.app (design only)
- [plans/done/2026-10-07-ebda-visual-builder-roadmap.md](plans/done/2026-10-07-ebda-visual-builder-roadmap.md) - Ebda visual page builder — roadmap and specification
- [plans/2026-10-07-egypt-payments-shipping-integrations.md](plans/2026-10-07-egypt-payments-shipping-integrations.md) - Egypt payments and shipping: connect-any-provider integrations
- [plans/done/2026-10-07-egypt-vat-and-eta.md](plans/done/2026-10-07-egypt-vat-and-eta.md) - Egypt VAT gating and ETA e-receipt / e-invoice — research and design
- [plans/2026-10-07-product-3d-viewer.md](plans/2026-10-07-product-3d-viewer.md) - Product 3D viewer + AR (design + implementation plan)
- [plans/done/2026-10-07-signup-funnel.md](plans/done/2026-10-07-signup-funnel.md) - Merchant signup funnel: plan choice, card on file, 14-day Growth trial
- [plans/done/2026-10-10-ebda-store-naming.md](plans/done/2026-10-10-ebda-store-naming.md) - Ebda Store / Ebda AI Studio naming implementation plan
- [plans/done/2026-10-11-stock-hold-admission.md](plans/done/2026-10-11-stock-hold-admission.md) - Stock-hold admission correction
- [plans/done/2026-10-14-looks-phase-s.md](plans/done/2026-10-14-looks-phase-s.md) - Looks — Phase S (system contract) Implementation Plan
- [plans/done/2026-10-14-marketing-levelup.md](plans/done/2026-10-14-marketing-levelup.md) - Marketing level-up (ebda.app) — 2026-10-14
- [plans/done/2026-10-14-marketing-looks-showcase.md](plans/done/2026-10-14-marketing-looks-showcase.md) - Marketing: interactive looks showcase — 2026-10-14
- [plans/done/2026-10-14-phase-b0-platform-commerce.md](plans/done/2026-10-14-phase-b0-platform-commerce.md) - Phase B0 — Platform Commerce Features Implementation Plan
- [plans/done/2026-10-14-templates-and-editor-program.md](plans/done/2026-10-14-templates-and-editor-program.md) - Templates + editor program (launch gate) — 2026-10-14
- [plans/done/2026-10-15-followups-b0-46.md](plans/done/2026-10-15-followups-b0-46.md) - B0-46 Follow-up Fixes Implementation Plan
- [plans/done/2026-10-15-phase-b1-qamar.md](plans/done/2026-10-15-phase-b1-qamar.md) - Phase B1 — Qamar (fashion & boutiques) Implementation Plan
- [plans/done/2026-10-15-policy-change-notify.md](plans/done/2026-10-15-policy-change-notify.md) - Policy Change Notify Implementation Plan
- [plans/done/2026-10-15-semantic-search.md](plans/done/2026-10-15-semantic-search.md) - Arabic + English Search Program (P0–P3) Implementation Plan
- [plans/done/2026-10-21-b2b-wholesale.md](plans/done/2026-10-21-b2b-wholesale.md) - B2B Wholesale Pricing Implementation Plan
- [plans/done/2026-10-21-cart-email-campaigns.md](plans/done/2026-10-21-cart-email-campaigns.md) - Cart-recovery email + email campaigns in plans (2026-10-21)
- [plans/done/2026-10-21-delete-old-force-skins.md](plans/done/2026-10-21-delete-old-force-skins.md) - Delete the Five Old Force Skins Implementation Plan
- [plans/done/2026-10-21-merchant-webhooks.md](plans/done/2026-10-21-merchant-webhooks.md) - Merchant outgoing webhooks (2026-10-21)
- [plans/done/2026-10-21-passkeys.md](plans/done/2026-10-21-passkeys.md) - Passkeys (WebAuthn) for merchants and shoppers - 2026-10-21
- [plans/done/2026-10-21-phase-b2-souq.md](plans/done/2026-10-21-phase-b2-souq.md) - Phase B2 — Souq (general retail & electronics) Implementation Plan
- [plans/done/2026-10-21-phase-b3-jasmine.md](plans/done/2026-10-21-phase-b3-jasmine.md) - Phase B3 — Jasmine (beauty & skincare) Implementation Plan
- [plans/done/2026-10-21-phase-b4-lamma.md](plans/done/2026-10-21-phase-b4-lamma.md) - Phase B4 — Lamma (home food & home kitchens) Implementation Plan
- [plans/2026-11-05-nz-17-postgres-removal.md](plans/2026-11-05-nz-17-postgres-removal.md) - N-17: inventory of Postgres residue, what replaces the Postgres integration suite, CI footprint (2026-11-05)
- [plans/done/2026-11-03-sharia-gold-bnpl-aup.md](plans/done/2026-11-03-sharia-gold-bnpl-aup.md) - Sharia decisions: gold prepaid, BNPL off by default, acceptable use (2026-11-03)
- [plans/done/2026-10-21-phase-b5-dahab-looks.md](plans/done/2026-10-21-phase-b5-dahab-looks.md) - Phase B5 — Dahab redesign: Worn / Workshop / Gift box Implementation Plan
- [plans/done/2026-10-21-search-p3-catalogue-import.md](plans/done/2026-10-21-search-p3-catalogue-import.md) - Search P3: Catalogue Import from Photos and PDFs Implementation Plan
- [plans/done/2026-10-21-shaped-barcodes.md](plans/done/2026-10-21-shaped-barcodes.md) - Shaped, scannable order barcodes (2026-10-21)
- [plans/done/2026-10-21-template-editor-pass.md](plans/done/2026-10-21-template-editor-pass.md) - Template Editor Pass Implementation Plan
- [plans/2026-10-22-visual-editor.md](plans/2026-10-22-visual-editor.md) - Visual Editor Implementation Plan
- [plans/2026-10-23-launch-polish.md](plans/2026-10-23-launch-polish.md) - Launch step 5: impeccable polish pass (5 templates x 3 looks + visual editor)
- [plans/done/2026-10-23-marketing-captures.md](plans/done/2026-10-23-marketing-captures.md) - Marketing captures refresh (launch step 6) - 2026-10-23
- [plans/done/2026-10-24-cf-phase0-go-no-go.md](plans/done/2026-10-24-cf-phase0-go-no-go.md) - Phase 0 go/no-go: Ebda Store on Cloudflare only (Ruling INFRA-CF-1)
- [plans/done/2026-10-24-cf-phase2-architecture.md](plans/done/2026-10-24-cf-phase2-architecture.md) - Phase 2 architecture: how the repo layer reaches 2,500 Prisma call sites (Ruling CF-REPO-1, PROPOSED)
- [plans/done/2026-10-24-identity-extraction.md](plans/done/2026-10-24-identity-extraction.md) - Shared identity service: extraction plan (Rulings ID-1, ID-2, ID-3)
- [plans/done/2026-10-24-looks-from-live-demos.md](plans/done/2026-10-24-looks-from-live-demos.md) - Looks from the live demo stores (Ruling MKT-PHONES-1) - 2026-10-24
- [plans/done/2026-10-25-ci1-capture-impl.md](plans/done/2026-10-25-ci1-capture-impl.md) - CI-1 capture: implementation plan (Store, pre-launch)
- [plans/2026-10-25-providers-unverified-connect.md](plans/2026-10-25-providers-unverified-connect.md) - Providers: connect unverified providers, check on save, learn from the first merchant
- [plans/2026-10-25-templates-match-mockups.md](plans/2026-10-25-templates-match-mockups.md) - Make the real templates look like the Python mock-ups (2026-10-25)
- [plans/done/2026-10-25-wa-store-contract-store-side.md](plans/done/2026-10-25-wa-store-contract-store-side.md) - Ebda Store side of the WhatsApp contract (producer, consumer, buyer key)
- [plans/done/2026-10-26-search-as-you-type.md](plans/done/2026-10-26-search-as-you-type.md) - Search as you type, everywhere (2026-10-26)
- [plans/2026-11-12-arabic-stemming.md](plans/2026-11-12-arabic-stemming.md) - Arabic light stemming for storefront search (2026-11-12)
- [plans/2026-10-26-storefront-locale-paths.md](plans/2026-10-26-storefront-locale-paths.md) - Storefront English at its own URL (audit M-168, SEO-9)
- [plans/done/2026-10-28-customer-intelligence.md](plans/done/2026-10-28-customer-intelligence.md) - Customer Intelligence (CI): capture, internal learning, merchant features
- [plans/done/2026-10-28-store-on-cloudflare.md](plans/done/2026-10-28-store-on-cloudflare.md) - Ebda Store on Cloudflare only: detailed executable plan
- [plans/done/2026-11-03-admin-audit-polish.md](plans/done/2026-11-03-admin-audit-polish.md) - Admin impeccable-audit polish: plan gate, OneSignal opt-in, formatting, Egyptian copy, sign-in
- [plans/2026-11-02-neon-zero.md](plans/2026-11-02-neon-zero.md) - NEON-ZERO-1: the Ebda API with zero Postgres, Neon or Hyperdrive (inventory, scale rules, design note)
- [plans/done/2026-11-03-editor-theme-spacing.md](plans/done/2026-11-03-editor-theme-spacing.md) - SP-1..3: simplified Theme panel (tiers, presets, density) and per-section, per-device spacing in the visual editor
- [plans/done/2026-11-03-contact-form.md](plans/done/2026-11-03-contact-form.md) - CONTACT-FORM-1: studio service-enquiry form on the contact page
- [plans/done/2026-11-03-storefront-premium-defaults.md](plans/done/2026-11-03-storefront-premium-defaults.md) - Storefront premium defaults (audit 2026-11-03)
- [plans/ai-features.md](plans/ai-features.md) - AI features plan — making "Ebda AI Studio" mean something
- [plans/done/2026-10-26-barcode-1.md](plans/done/2026-10-26-barcode-1.md) - BARCODE-1 Product Barcodes and Label Printing Implementation Plan
- [plans/done/2026-10-26-qr-1.md](plans/done/2026-10-26-qr-1.md) - QR-1 Merchant QR Codes Implementation Plan
- [plans/done/2026-11-10-store-miss-counts-unverified-store-only.md](plans/done/2026-11-10-store-miss-counts-unverified-store-only.md) - LAUNCH-RL-MISS-3: a dead product or blog link inside a verified store is not a store-miss
- [plans/done/2026-11-10-ssr-client-address.md](plans/done/2026-11-10-ssr-client-address.md) - RL-SSR-IP-6: storefront server renders forward the shopper address (signed with REVALIDATE_SECRET) so the API limits charge the shopper, not the storefront Worker
- [plans/2026-11-11-nz-money-auth.md](plans/2026-11-11-nz-money-auth.md) - NZ money + auth: InstaPay refund record, refund match-claim, agent COD, WhatsApp COD outcome, grants, tax report, customer MFA, merchant e-mail flows on a Durable Object store
- [plans/done/2026-11-10-services-header-actions.md](plans/done/2026-11-10-services-header-actions.md) - the Menu's CTA and WhatsApp as one pinned pair, the short contact CTA on service pages, and the header bar's width ladder (NAV-CTA-2, NAV-MENU-ACTIONS-1, NAV-BAR-FIT-1)
- [plans/done/2026-11-10-resolve-bulletproof.md](plans/done/2026-11-10-resolve-bulletproof.md) - Store resolution bulletproofing: epoch-checked caches, stale-if-error, 503 + Retry-After (Ruling RESOLVE-BULLETPROOF-1)
- [plans/2026-11-10-storefront-cold-render.md](plans/2026-11-10-storefront-cold-render.md) - PERF-LATENCY: why a cold storefront render took 4-12 s (empty per-build data cache after every deploy), the build-independent fetch cache and the widened warm step (Ruling WEB-COLD-2)
- [plans/done/2026-11-10-accounts-standalone-signin.md](plans/done/2026-11-10-accounts-standalone-signin.md) - ACCOUNTS-PAGE-1: accounts.ebda.app/login as a standalone Ebda AI Studio sign-in page over the same /login and /login/mfa, allowlisted return
- [plans/done/2026-11-10-api-hangs.md](plans/done/2026-11-10-api-hangs.md) - API-HANG-1: every AuthState call bounded at 2.5 s, a public cache fill answers before its write-back

## privacy - Privacy

- [privacy/data-map.md](privacy/data-map.md) - Data map (Record of Processing Activities)
- [privacy/erasure-export.md](privacy/erasure-export.md) - PDPL erasure and export on Cloudflare storage (G10)

## runbooks - Runbooks

- [runbooks/STAGING-DEPLOYMENT.md](runbooks/STAGING-DEPLOYMENT.md) - Staging deployment + promotion flow
- [runbooks/SUPER-ADMIN-PLAYBOOK.md](runbooks/SUPER-ADMIN-PLAYBOOK.md) - Super-admin playbook
- [runbooks/analytics-cutover.md](runbooks/analytics-cutover.md) - Per-store analytics to the StoreDO, AiUsage to D1 (controller runs it)
- [runbooks/platform-family-cutover.md](runbooks/platform-family-cutover.md) - Platform table family cutover, Postgres to D1 (controller runs it)
- [runbooks/grant-plan-d1.md](runbooks/grant-plan-d1.md) - Grant a plan on platform D1 with no money row (internal stores; controller runs it)
- [runbooks/drop-legacy-app-role.md](runbooks/drop-legacy-app-role.md) - Drop the unused legacy app login role (production Neon)
- [runbooks/ebda-names-rollout.md](runbooks/ebda-names-rollout.md) - Rollout: Ebda names replace the inherited service, token and env names
- [runbooks/google-search-console-indexing.md](runbooks/google-search-console-indexing.md) - Google Search Console — Indexing Guide for demo-merchant.com
- [runbooks/inngest-reliability.md](runbooks/inngest-reliability.md) - Inngest Reliability Runbook
- [runbooks/legal-policy-change.md](runbooks/legal-policy-change.md) - How to publish a legal policy change
- [runbooks/lighthouse-audit.md](runbooks/lighthouse-audit.md) - Lighthouse storefront audit
- [runbooks/locale-paths-canary.md](runbooks/locale-paths-canary.md) - Language-in-the-URL canary (Ruling LOCALE-PATHS-1)
- [runbooks/mfa-recovery.md](runbooks/mfa-recovery.md) - MFA Recovery Runbook
- [runbooks/orders-pwa-deploy.md](runbooks/orders-pwa-deploy.md) - Orders PWA — Deploy + Domain Runbook
- [runbooks/ososs-migration.md](runbooks/ososs-migration.md) - OSOSS → Ebda Store Migration Runbook
- [runbooks/rotate-bosta-webhook-secrets.md](runbooks/rotate-bosta-webhook-secrets.md) - Rotate the Bosta webhook secrets (all stores)
- [runbooks/scoped-audit-followups.md](runbooks/scoped-audit-followups.md) - Scoped Audit — followup issue dedup
- [runbooks/store-locations.md](runbooks/store-locations.md) - Store Locations — runbook
- [runbooks/support-wholesaler-sees-retail.md](runbooks/support-wholesaler-sees-retail.md) - Support: "a wholesaler sees the retail price"
- [runbooks/tenant-routing-canary.md](runbooks/tenant-routing-canary.md) - Tenant routing canary (demo-boutique first)
- [runbooks/whatsapp-og-preview.md](runbooks/whatsapp-og-preview.md) - WhatsApp / Social Link Preview Runbook
- [runbooks/cutover-cf.md](runbooks/cutover-cf.md) - Cutover runbook: Postgres (Neon) to Cloudflare (StoreDO + D1); go/no-go, write freeze, rollback replay, Neon decommission gate; rehearsed by `scripts/cf/rehearse-cutover.sh` (Ruling CUTOVER-5)
- [runbooks/neon-decommission.md](runbooks/neon-decommission.md) - Neon decommission (INFRA-CF-1 phase 7)

## security - Security

- [security/audit-2026-10-14.md](security/audit-2026-10-14.md) - Security audit — 2026-10-14 (static, `apps/api` + `packages/database`)
- [security/burp-manual-pentest-checklist.md](security/burp-manual-pentest-checklist.md) - Manual Burp Suite Pentest Checklist (quarterly)
- [security/csp-hardening-plan.md](security/csp-hardening-plan.md) - CSP hardening: removing `script-src 'unsafe-inline'`
- [security/defence-mutation-record.md](security/defence-mutation-record.md) - Defence mutation record — Ebda
- [security/defence-mutations.json](security/defence-mutations.json) - defence mutations
- [security/sec-hardening-1-ai-moderation.md](security/sec-hardening-1-ai-moderation.md) - SEC-2 / SEC-11: AI review moderation and the InstaPay receipt reader
- [security/sec-hardening-2-webhooks.md](security/sec-hardening-2-webhooks.md) - SEC-5 / SEC-8: verify payment webhooks before persisting; redact secrets in paths
- [security/sec-hardening-3-exposure.md](security/sec-hardening-3-exposure.md) - SEC-6 / SEC-14 / SEC-15: OG image SSRF, PII export permission, guest order view token
- [security/security-overview.md](security/security-overview.md) - Security Overview — Ebda Store
- [security/zap-triage-2026-07-15.md](security/zap-triage-2026-07-15.md) - ZAP Baseline Triage — first activated run (2026-07-15)

## superpowers - Specs and plans written through the superpowers workflow

- [superpowers/audits/2026-05-18-per-theme-image-spec-audit.md](superpowers/audits/2026-05-18-per-theme-image-spec-audit.md) - Per-Theme Image Spec Audit
- [superpowers/design/locations/DESIGN.md](superpowers/design/locations/DESIGN.md) - DESIGN
- [superpowers/plans/2026-03-18-upsell-crosssell.md](superpowers/plans/2026-03-18-upsell-crosssell.md) - Upsell / Cross-sell / Recommendations Implementation Plan
- [superpowers/plans/2026-04-23-admin-i18n-and-extractions-plan.md](superpowers/plans/2026-04-23-admin-i18n-and-extractions-plan.md) - Admin i18n + Page Extraction Implementation Plan
- [superpowers/plans/2026-04-23-final-push-plan.md](superpowers/plans/2026-04-23-final-push-plan.md) - Final Push — Plan
- [superpowers/plans/2026-04-23-remaining-refactors-master-plan.md](superpowers/plans/2026-04-23-remaining-refactors-master-plan.md) - Remaining Refactors — Master Plan
- [superpowers/plans/2026-04-29-tenant-control-batch-2.md](superpowers/plans/2026-04-29-tenant-control-batch-2.md) - Tenant Control Batch 2 — 2026-04-29
- [superpowers/plans/2026-11-14-instapay-auto-confirm.md](superpowers/plans/2026-11-14-instapay-auto-confirm.md) - InstaPay Auto-Confirm Implementation Plan
- [superpowers/plans/2026-05-04-storefront-per-store-pwa-full-sizes.md](superpowers/plans/2026-05-04-storefront-per-store-pwa-full-sizes.md) - Storefront per-store PWA — extend to full size set
- [superpowers/plans/2026-05-16-mobile-ui-ship.md](superpowers/plans/2026-05-16-mobile-ui-ship.md) - Mobile UI ship — match Storefront + Bank-Alkahraman sizing
- [superpowers/plans/2026-05-17-ui-ux-refresh-from-references.md](superpowers/plans/2026-05-17-ui-ux-refresh-from-references.md) - Ebda Store Storefront UI/UX Refresh — Plan
- [superpowers/plans/2026-05-27-feature-tiering-and-access-control.md](superpowers/plans/2026-05-27-feature-tiering-and-access-control.md) - Feature tiering + super-admin access control — implementation plan
- [superpowers/plans/2026-06-05-checkout-concurrency-scaling.md](superpowers/plans/2026-06-05-checkout-concurrency-scaling.md) - Checkout Concurrency Scaling Implementation Plan
- [superpowers/plans/2026-06-08-mfa-and-token-revocation.md](superpowers/plans/2026-06-08-mfa-and-token-revocation.md) - Ebda Store — TOTP 2FA + Access-Token Revocation Implementation Plan
- [superpowers/plans/2026-06-14-loyalty-redeem-checkout.md](superpowers/plans/2026-06-14-loyalty-redeem-checkout.md) - Loyalty redemption at checkout — end-to-end wiring
- [superpowers/plans/2026-06-15-barcode-scanning.md](superpowers/plans/2026-06-15-barcode-scanning.md) - Barcode Scanning — Implementation Plan
- [superpowers/plans/2026-06-15-multi-warehouse.md](superpowers/plans/2026-06-15-multi-warehouse.md) - Multi-Warehouse Inventory — Implementation Plan
- [superpowers/plans/2026-06-16-branding-full-color-editor.md](superpowers/plans/2026-06-16-branding-full-color-editor.md) - Branding full color editor + Smart Palette generator + hex fix
- [superpowers/plans/2026-07-16-refund-money-integrity.md](superpowers/plans/2026-07-16-refund-money-integrity.md) - Refund Money-Integrity Redesign — Implementation Plan
- [superpowers/plans/2026-07-22-answer-engine-insights-8A-citation.md](superpowers/plans/2026-07-22-answer-engine-insights-8A-citation.md) - Answer-Engine Insights — Plan 8A: Citation Checking Implementation Plan
- [superpowers/plans/2026-07-22-slug-redirects.md](superpowers/plans/2026-07-22-slug-redirects.md) - Slug Redirects Implementation Plan
- [superpowers/plans/2026-07-23-answer-engine-insights-8B-gsc.md](superpowers/plans/2026-07-23-answer-engine-insights-8B-gsc.md) - Answer-Engine Insights — Plan 8B: Force-Managed GSC Ingestion
- [superpowers/plans/2026-07-23-warehouse-stock-integrity.md](superpowers/plans/2026-07-23-warehouse-stock-integrity.md) - WarehouseStock Data-Integrity Fixes — Implementation Plan
- [superpowers/plans/2026-08-30-variant-stock-drift.md](superpowers/plans/2026-08-30-variant-stock-drift.md) - Variant Stock Drift — Implementation Plan
- [superpowers/specs/2026-03-18-affiliate-program-design.md](superpowers/specs/2026-03-18-affiliate-program-design.md) - Phase 7: Affiliate / Influencer Program — Design Spec
- [superpowers/specs/2026-03-18-feature-toggle-engine-design.md](superpowers/specs/2026-03-18-feature-toggle-engine-design.md) - Phase 0: Feature Toggle Engine — Design Spec
- [superpowers/specs/2026-03-18-upsell-crosssell-design.md](superpowers/specs/2026-03-18-upsell-crosssell-design.md) - Phase 4: Upsell / Cross-sell / Recommendations — Design Spec
- [superpowers/specs/2026-04-23-admin-i18n-design.md](superpowers/specs/2026-04-23-admin-i18n-design.md) - Admin Dashboard Internationalization — Design Spec
- [superpowers/specs/2026-04-23-phase-2-template-contract-extension-design.md](superpowers/specs/2026-04-23-phase-2-template-contract-extension-design.md) - Phase 2 — Template Contract Extension + Remaining Card Swaps
- [superpowers/specs/2026-04-23-storefront-template-coverage-phase-1-design.md](superpowers/specs/2026-04-23-storefront-template-coverage-phase-1-design.md) - Storefront Template Coverage — Phase 1 Design
- [superpowers/specs/2026-04-26-demo-store-home-flow-design.md](superpowers/specs/2026-04-26-demo-store-home-flow-design.md) - Storefront Home Flow — Storefront Spec
- [superpowers/specs/2026-05-12-per-store-resend-email-design.md](superpowers/specs/2026-05-12-per-store-resend-email-design.md) - Per-store branded email via Resend — design
- [superpowers/specs/2026-05-18-smart-colors-and-page-builder-design.md](superpowers/specs/2026-05-18-smart-colors-and-page-builder-design.md) - Smart Colors + Unified Page Builder — Design
- [superpowers/specs/2026-05-25-whatsapp-native-catalog-bot-design.md](superpowers/specs/2026-05-25-whatsapp-native-catalog-bot-design.md) - WhatsApp Native Catalog Bot — Design Spec
- [superpowers/specs/2026-07-22-answer-engine-insights-design.md](superpowers/specs/2026-07-22-answer-engine-insights-design.md) - Answer-Engine / Citation Measurement ("Answer-Engine Insights") — Design Spec
- [superpowers/specs/2026-07-22-promotions-engine-and-coupon-targeting-design.md](superpowers/specs/2026-07-22-promotions-engine-and-coupon-targeting-design.md) - Promotions Engine + Coupon Targeting — Design (Core + targeting)
- [superpowers/specs/2026-07-23-warehouse-stock-integrity-design.md](superpowers/specs/2026-07-23-warehouse-stock-integrity-design.md) - WarehouseStock Data-Integrity Fixes — Design Spec
- [superpowers/specs/2026-09-11-mcp-merchant-admin-design.md](superpowers/specs/2026-09-11-mcp-merchant-admin-design.md) - MCP Merchant-Admin Surface — Design Spec

## testing - Test programs

- [testing/prelaunch-program.md](testing/prelaunch-program.md) - Pre-launch test program

## third-party - Third-party notes

- [third-party/barkod-studio.md](third-party/barkod-studio.md) - BARKOD studio shape drawings

## uat - User acceptance testing

- [uat/admin-orders.md](uat/admin-orders.md) - UAT: Admin Order Management
- [uat/ai-sweeps.md](uat/ai-sweeps.md) - UAT: AI Tools — Bulk Sweeps
- [uat/checkout.md](uat/checkout.md) - UAT: Guest Checkout (Kashier)
- [uat/coupon-validation.md](uat/coupon-validation.md) - UAT: Coupon /validate — Rate Limiting & Error Enumeration
- [uat/finance-expense-journal.md](uat/finance-expense-journal.md) - UAT: Finance — Expense Creation & Journal Entry
- [uat/low-stock-alerts.md](uat/low-stock-alerts.md) - UAT: Low-Stock Alert Email
- [uat/loyalty-redemption.md](uat/loyalty-redemption.md) - UAT: Loyalty Points Redemption at Checkout
- [uat/marketing-pixel-secrets.md](uat/marketing-pixel-secrets.md) - UAT: Marketing Pixels — Secret Masking & Safe Resubmit
- [uat/mfa.md](uat/mfa.md) - UAT Checklist — Two-Factor Authentication (MFA)
- [uat/newsletter-broadcast.md](uat/newsletter-broadcast.md) - UAT: Newsletter Broadcast — HTML Sanitization
- [uat/pixels-capi.md](uat/pixels-capi.md) - UAT — Server-Side Conversions (Meta CAPI + TikTok Events API)
- [uat/store-creation.md](uat/store-creation.md) - UAT: Store Creation (Super-Admin Flow)
- [uat/storefront-design-save.md](uat/storefront-design-save.md) - UAT: Storefront Design Save — Smart Palette & Page Builder
- [uat/tax-reports.md](uat/tax-reports.md) - UAT — Tax Reports (accounting.tax_reports)
- [plans/done/2026-11-10-preqa-p2-batch.md](plans/done/2026-11-10-preqa-p2-batch.md) - Pre-QA sweep P2 batch: JSON-LD on every marketing page, brand name in legal copy, guest auth calls, menu vs cookie bar, look preview colour, checkout selects, returns register, /en manifest (2026-11-10)
- [plans/done/2026-11-10-review-followups.md](plans/done/2026-11-10-review-followups.md) - the #510/#511/#512 review fix-after items and the R20 template cleanup: four tests made to fail on the real defect, the Menu start button CSS, the SEO majority-Arabic rule, D1 0009 / StoreDO 0004 (SEO-LANG-SHARE-1, SKIN-DEL-9, REVIEW-FU-1)
- [plans/done/2026-11-10-qa-p2-admin-batch.md](plans/done/2026-11-10-qa-p2-admin-batch.md) - QA P2-1..10 status on main, F6 onboarding look name + i18n guards, F2 search (already fixed), storefront auth refusals in Arabic (2026-11-10)
- [plans/done/2026-11-10-ci-full-lane-on-main.md](plans/done/2026-11-10-ci-full-lane-on-main.md) - CI-FULL-MAIN-1: every push to main and a nightly run the full CI lane (build, integration, workerd incl. route-sweep, e2e, audit); a red main opens the ci-main-red issue (2026-11-10)
- [plans/done/2026-11-11-bootstrap-super-admin.md](plans/done/2026-11-11-bootstrap-super-admin.md) - Password-less platform super-admin bootstrap + daily 0-admin invariant (Ruling ID-20)
- [plans/done/2026-11-12-storage-limit-enforce.md](plans/done/2026-11-12-storage-limit-enforce.md) - S3-X8: enforce maxStorageMb on the four upload routes, usage from the R2 listing (60 s bounded-stale)
- [plans/2026-11-12-auto-recommendations.md](plans/2026-11-12-auto-recommendations.md) - Automatic product recommendations: merchant picks, then bought-together, then similar items (Vectorize), cap 8, merchant switch
- [plans/2026-11-15-self-service-addons.md](plans/2026-11-15-self-service-addons.md) - Self-service Add-ons page: delta on the #775 stack (state model, NEVER-stale expiry, history, locked-state buy path, InstaPay proposal)
