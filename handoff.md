# Ebda UI handoff

## Goal
Assess launch readiness, remove exposed Ebda naming, improve UI and fix wiring/errors; prove backend operation in Cloudflare workerd. Mobile is mandatory end-to-end.

## Ebda naming — 2026-10-10

- Goal: product Ebda Store (ابدأ ستور), company Ebda AI Studio (ابدأ ستوديو للذكاء الاصطناعي), approved across folders/repo/app branding.
- Done: private repo renamed to Whisky-11/ebda-store; product root `Ebda-AI-Studio/internal-projects/ebda-store`; local business papers `Ebda-AI-Studio/business/ebda-ai-studio`. All 23 worktree registrations/statuses preserved. Foundation PR227 merged and resolver installed; canonical name and legacy alias resolve correctly (18 tests).
- Validation: 113 affected branding and sibling tests pass; final CI-parity run 10,009 tests across 752 files passed. Monorepo typecheck, lint, formatting and affected app builds pass. All-email scope reviewed: 328 targeted tests plus full-unit coverage; localized platform names/attribution, company team copy, merchant branding preserved. CI browser dependency failure repaired in both unit jobs (missing libatk). AR/EN marketing checked at 390/820/1280px and merchant login at 390px with no overflow.
- Blast-radius: current app/config/workflow/scripts, installed scripts and launchd jobs swept; stale audit fallback paths and two current audit-document links fixed. Two dated historical records keep old repo URLs; approved naming plan retains its baseline and move instructions. Domains/resources unchanged.
- Current state: PR72 merged as `2ae3d78acae4b49cad811c6231c40c7bf80a6a1c`. All five guarded Cloudflare deployments succeeded (marketing, admin, web, orders and API). API `/health` reports this commit. All 14 live marketing sitemap pages have the localized company title; representative AR/EN headers/social metadata and merchant/orders login screens render correctly at390px with no overflow. Actual AR/EN billing email previews rendered locally; no emails sent.
- Left to do: external email delivery/client rendering and authenticated merchant screens were not exercised in production. Google recrawl/index title remains outside this verification. Docs/help/status hosts returned404 before this change and lack current publishing wiring; their source builds are updated. Codex's saved project entry is stale; computer-use access to Codex was denied by the tool, so refresh requires supported app UI access.
- Ruling EBDA-ROLLOUT-CLOCK: both runner services were active but GitHub reported offline; the guest clock lagged host/server by26minutes and runner logs reported expired tokens. Set guest UTC from host epoch; both runners reconnected without configuration changes. Cost if wrong: clock jumps affect timers; no jobs were running at correction.
- Rulings: `docs/decisions/2026-10-10-product-company-naming.md` records identity, MFA compatibility, footer and graph output decisions.

## Current state
Naming task (2026-10-10): approved plan `docs/plans/2026-10-10-ebda-store-naming.md`; branch `chore/ebda-store-naming`. Product = Ebda Store; company = Ebda AI Studio. Explicit brand contract passed 11 tests after 3 observed failures. Repo/folder move and production verification are complete for the active apps; residuals are listed above. Existing historical handoff below is preserved.

Branch `codex/ebda-ui-ux`, worktree `/private/tmp/ebda-ui-20261005`, baseline `89461087`. Root `plan` and unrelated `.handoff/` preserved. PR #3: https://github.com/Whisky-11/ebda/pull/3. Initial UI commits `9d047026`/`0a91f0ce`; expanded launch fixes `23acd07b` committed for PR #3. PR #3 merged the earlier UI head only. PR #4 carries subsequent backend fixes; authorized merge in progress, no deploy. Local built Worker preview: http://localhost:8788/signup.

## Done
UI implementation, bilingual browser checks, 131 targeted tests, admin typecheck, final OpenNext build and Wrangler dry run. Local workerd signup/logo 200; browser rendered both languages. CF generated routes corrected to BRAND authority. AST graph refreshed. Exact evidence and rulings: docs/ebda/ui/2026-10-05-merchant-ui-verification.md.

## In progress
Local implementation and verification complete; review PR delivery complete after remote verification. Full unit suite 6,762 passed, plus deployment-config guard; 29 workerd tests; strict-role two-store cron integration; complete local signup→COD order flow; actual admin signup against local Worker passed.

## Left to do
Live launch needs migrated strict-role Neon URL, provisioned Hyperdrive/KV/queues, GitHub CF inputs, Worker secrets, sender/DNS and real provider/UAT proof. Manual API deployment workflow is now prepared, not dispatched. Dependency audit retains 14 high upstream build-tool findings (braces/extract-zip); available FTP fix applied. Live API/payment/order verification requires backend and authorized production checks. Review/merge/deployment belongs to Ahmad's subsequent authorization.

Rulings UI-1 through UI-4: docs/plans/2026-10-05-ebda-merchant-ui.md. UI-5 through UI-7: verification document. Scope keeps payments/money/entitlements/merchant storefront palettes unchanged; only generated CF routing follows owner Cloudflare steering.

Expanded proof and rulings: docs/ebda/launch-readiness-2026-10-05.md. Local API 4896, isolated PG 55439. No production writes.

Neon inventory could not be read: CLI required authentication; the pending login was cancelled. Existing production database presence is unverified.

Ruling MERGE-1 — CI Worker dry-runs explicitly exercise cache-enabled generated bindings; production still requires an explicit repository cache setting. Evidence: no repository cache variable, dry-run provisions nothing, deploy assertion remains unchanged. Cost if wrong: CI misses the production empty-cache mode (covered by unit tests).
Ruling MERGE-2 — allowlist only the two exact synthetic shipping fixture values; retain full-history secret scanning. Evidence: literal fixtures in contract/integration assertions, no production use. Cost if wrong: a matching real credential would be hidden.

## Locked pricing (branch `feat/locked-pricing`, PR to main, not merged, not deployed)
Basic / Growth / Business = EGP 1,490 / 3,490 / 9,990 (annual 25% off), 0 fee, no free plan, 14-day Growth trial. Source: docs/plans/2026-10-05-pricing-decisions.md; implementation map and rulings R-EBDA-PRICING-1..10 in docs/plans/2026-10-05-pricing-implementation.md and docs/RULINGS.md.
Done: catalog migration `20261007000000_locked_pricing` (DB == `DEFAULT_PLAN_SEEDS`, hidden free/pro/comped kept, `founding_free` added unassigned); gates at the server write path for stores 1/1/3, branding removal (Growth+Business), API access (Business), analytics tiers, order cap incl. payment-links; marketing + help (ar/en) show real prices.
Left: parent/child billing for extra stores (R-EBDA-PRICING-6); upsell UI for 402 on gated analytics pages; Amelia still on `comped`; first store created by `POST /stores` is Basic-active with no checkout; live billing/UAT/deploy not exercised. Local PG container `ebda-pricing-pg` (Apple `container`) can be removed.

## Signup funnel (branch `feat/signup-funnel`, stacks on #10; PR to main, not merged, not deployed)
Goal: plan choice, then card on file (nothing charged) OR InstaPay, then a 14-day Growth trial; daily reminders, charge or overdue, suspension; super-admin manual payments; store allowance; upsell UI. Plan: docs/plans/2026-10-07-signup-funnel.md. Rulings: EBDA-FUNNEL-1..15 in docs/RULINGS.md.
State: API, migration `20261007160000_signup_funnel`, admin + marketing UI, and the unit + integration tests are done locally (local PG container `ebda-funnel-pg` :55441, redis `ebda-funnel-redis` :56391, both Apple `container`; remove when finished).
Left: Kashier has no documented no-charge tokenization, so card-on-file needs Kashier's written enablement (Ruling 2). Kashier MIT charge path is unverified against the docs (fep host / CONTAUTH / agreement id). Production steps: set EBDA_INSTAPAY_HANDLE + EBDA_SUPPORT_WHATSAPP; move Amelia off `comped` by recording her InstaPay payment in super-admin. Not live-verified: no deploy.

## Egypt VAT gate phase 1 (branch `feat/vat-gate`, PR to main, not merged, not deployed)
Goal: no VAT unless the merchant's VAT registration is VERIFIED by a super-admin; Ebda's own subscription VAT a super-admin setting, default OFF. Rulings TAX-2..TAX-9 in docs/RULINGS.md (TAX-2 supersedes TAX-1's "taxEnabled alone").
Done: migration `20261007140000_vat_gate` (store_tax_profiles + store_tax_documents under strict RLS, nullable order TRN/rate columns, review + platform-VAT triggers, definer queue); resolver gate + settings 409; merchant VAT card on /stores/[id]/tax; super-admin /tax-verification and /platform-settings; tax-invoice wording; help vat-registration (ar/en).
Left: billing must call `getPlatformVat()` (call sites in the PR body; billing agent); prod read-only check of `stores.tax_enabled` / `orders.tax > 0` before deploy (TAX-3); ETA phases P2+. Local PG container `ebda-vat-pg` (55473) + `ebda-vat-redis` (56473) can be removed.

## Billing follow-ups (branch `fix/billing-followups`, PR to main, not merged, not deployed)
Goal: InstaPay QR on the merchant pay screens; support email fallback while there is no WhatsApp number; Ebda's own VAT wired into subscription billing. Rulings EBDA-BILLFU-1..4 in docs/RULINGS.md.
Done: `EBDA_INSTAPAY_QR_URL` (wrangler var) + shared `InstapayPanel` (QR, copy buttons, phone steps, VAT line); `EBDA_SUPPORT_EMAIL` / `BRAND.contactEmail` + `SupportLink` (emails, billing notice, banner); `chargeFor()` reads `getPlatformVat()` for every subscription amount; migration `20261007200000_billing_event_vat` (`vat_minor`, `vat`); VAT line + Ebda TRN on merchant invoices and the super-admin ledger.
Left: deploy (merge runs it); after deploy check the pay screen shows the QR on admin.ebda.app. Local containers `ebda-billfu-pg` (:55491) + `ebda-billfu-redis` (:56491) can be removed.

## Admin/web/orders Workers deploy (branch `ci/deploy-apps`, 2026-10-07)
Goal: admin.ebda.app sign-up live; storefront + orders on Workers with GitHub deploy workflows.
Done: first deploy of `ebda-admin`, `ebda-orders`, `ebda-web` run locally from this branch's build (same generator + build as the workflows); Worker-less exclusion routes `media.ebda.app/*` + `preview.ebda.app/*`; `REVALIDATE_SECRET` on ebda-web (Keychain `ebda-web-REVALIDATE_SECRET`); workflows `cf-{admin,web,orders}-deploy.yml`; route generator stops claiming the apex (Rulings EBDA-DEPLOY-1..3 in docs/RULINGS.md).
Left: wildcard DNS `A * 192.0.2.0 proxied` (wrangler OAuth has no DNS write) — store subdomains do not resolve publicly until it exists; API side of revalidation (`REVALIDATE_SECRET` same value + `STOREFRONT_REVALIDATE_URL` on ebda-api); `NEXT_PUBLIC_ONESIGNAL_ORDERS_APP_ID` var; the honeypot overflow fix and EU PostHog CSP reach production on the first workflow run after merge.

## Shipping batch on the provider catalog (branch `feat/shipping-batch`, PR to main, not merged, not deployed)
Goal: Bosta, ShipBlu, Mylerz, Aramex (+ manual delivery) on the provider framework from #33 (Ruling PROVIDERS-3); iCarry removed (PROVIDERS-7 superseded).
Done: catalog entries + per-mode encrypted write-only credentials, Test connection, enable gate + runtime gate; migration `20261007230000_shipping_carrier_catalog`; four adapters built from the official OpenAPI/WSDL docs (Aramex is SOAP now); Bosta dual-factor webhook auth; schema-driven admin card; sandbox script for all four carriers; help mdx ar/en; rulings PROVIDERS-9..15 in docs/RULINGS.md; defence mutations for the new gates.
Left: every carrier is still `verified: false` ("coming soon"): run `node scripts/provider-sandbox-check.mjs <carrier> --create` with sandbox credentials (Bosta/ShipBlu need accounts, Mylerz publishes NO sandbox, Aramex needs the test host + product type) and flip `verified` with the record. Per-carrier COD statement column maps and Bosta's webhook `cod` as a remittance fact need Ahmad's call (PROVIDERS-14). A route that requests pickups for Bosta/Aramex/Mylerz.

## Provider follow-ups (branch `fix/provider-followups`)
Goal: Kashier confirm-before-apply (PROVIDERS-17) and merchant courier pickups for Bosta/Aramex/Mylerz (PROVIDERS-18, residuals PROVIDERS-19).
Done: `kashier-confirm.ts` + adapter/bridge `confirmWebhook`, `confirmBeforeApply` in `handleWebhook`, billing `confirmWebhookEvent`; migration `20261008120000_shipment_pickups`, `shipment-pickup.service.ts`, pickup routes, admin `ShipmentPickupPanel`, help ar/en, rulings. Unit + integration on local PG container `ebda-pf-pg` / `ebda-pf-redis` (Apple `container`; remove when finished).
Left: sandbox proof per provider (all still unverified); full defence-mutation record regeneration (PROVIDERS-19 g).

## Money fixes batch B (branch `fix/money-b`, 2026-10-08)
Goal: store-order money correctness for Egypt — gap-free tax invoices/receipts + credit notes, VAT base incl. shipping/COD fee, COD fee shown before ordering, 6-year tax archive surviving store deletion, shipping lifecycle through the status fan-out (+ return to origin), CSV prices in EGP, Egypt addresses/phones/copy. Rulings MONEYB-1..8 in docs/RULINGS.md; help `invoices-and-credit-notes` (new), `orders-and-cod`, `vat-registration`, `products-and-csv-import` (ar/en).
Done: migration `20261008160000_fiscal_documents_expand` (expand-only: `orders.cod_fee`, `orders.taxable_amount`, `fiscal_documents` + counters, immutability trigger, strict RLS, archive definers); merchant `/stores/[id]/invoices`, order Documents card, super-admin `/tax-archive`; manual refund requires a recorded method (`orders:refund`); unit + integration (local PG) green, mutation checks recorded in MONEYB rulings.
Left: rebase onto batch A when it merges (its migration `20261008130000_instapay_receipts` sorts after ours — rename ours past it if A lands first); after deploy check `/health` commit and the invoices page on a store; no purge job for `retain_until` (nothing expires before 2032-10). Local containers `ebda-moneyb-pg` / `ebda-moneyb-redis` (Apple `container`) can be removed.

## PR65 stock-hold admission correction — 2026-10-11

### Goal
Enforce COD/InstaPay unpaid-hold admission atomically; prevent gateway-to-manual bypass; exempt fully wallet-paid orders.

### Current state
Independent review has no remaining blockers. Normal local gate passes563files8426unit tests, typecheck/lint/format. Local PostgreSQL17:29checkout/wallet tests and8strict-app-role/payment-route tests pass; app-role has neither SUPERUSER nor BYPASSRLS. Original concurrency, email-casing and full-wallet defects reproduced before fixes.

### Done
Sorted tenant identity advisory locks/count/order insertion share the money transaction. Canonical email comparison/index covers legacy whitespace/case. Server-owned manualHoldAdmitted persists admission; new manual attachment refuses unadmitted orders while existing live same-provider retries remain supported. CGNAT test actually permits8contacts and rejects9th. Checkout renders actionable AR/EN refusal copy. Configuration docs and rulings updated.

### In progress
Rebase on merged PR67, exact-head CI and deploy preparation. Production migration intentionally unapplied, as required by saved plan.

### Left to do
Obtain Ahmad's explicit approval for production migration adding checkout_ip/manual_hold_admitted plus3partial indexes; apply via guarded schema-first API deployment only after CI. Verify production revision and actual changed paths; do not create a real order/payment or notify merchants. No active live storefront exists (owner read-only count verified with RLS inactive), so public badge interaction is test-proven only until QA preview/activation is addressed. Remaining overall handoff includes68–71,Dahab,saved editor/MCP patches,AR,templates,readiness and live merchant walk.

Blast-radius: swept admission/marker/error/config consumers across API,web,MCP,payment factory,retries,wallet,migrations,tests,docs andCI. MCP COD creates through OrderService; gateway factory excludes manual providers. No remaining bypass found.
