# FWB — Backlog completion (2026-06-01)

Final state: **`main` = `e7b3d05a`**, deployed + healthy (Railway API SUCCESS, migration applied, `/health` 200 db connected, Inngest re-registered, no boot errors). Vercel admin/web redeployed.

Landed in two pushes (`c4f1a9e2` features+AI/RLS fixes, `e7b3d05a` super-admin RLS sweep). All work built in isolated worktrees, typecheck-clean (shared/database/admin/web = 0 errors; api no new errors vs ~47 pre-existing baseline), discount unit tests 19/19, pushed with author `Ahmad Sharaf <ahmed0montaser@gmail.com>`.

## B-group — Product discount feature
- Schema: `DiscountType { percentage | fixed }` enum + nullable `discount_type`/`discount_value` on `products` (additive migration `20260601000000_add_product_discount`, applied).
- Encoding: percentage = basis points (12.5% → 1250); fixed = fils.
- Shared helper `packages/shared/src/utils/discount.ts` (`computeDiscountAmount`, `applyDiscount`, `deriveDiscountInput`) + 19 unit tests.
- Admin product create + edit forms: fields reordered **Price (regular) → Cost → Discount (dropdown None/Percentage(%)/Fixed(KWD) + value) → Preview** (live computed discounted price + "X% off"). Raw compareAtPrice input removed (now derived).
- **Non-breaking**: on save, `price`/`compareAtPrice` are derived from regular+discount, so all ~10 storefront price surfaces are unchanged. Legacy products with manual compareAtPrice round-trip as a fixed discount.
- API: Zod + service persist the two new fields. Bulk CSV/XLSX import NOT extended (deferred — would need discount-aware column mapping).

## A-group — Page-builder consolidation
- **A4** Category Pages card restored to Settings (→ `/categories`).
- **A2** Storefront Navigation moved into Page Builder via reusable `NavMenuEditor` (standalone route kept alive, card removed from Settings).
- **A1** Footer Links redundancy removed — page builder now owns it; `/pages` standalone route kept alive, its Settings card removed.
- **A3** Branding/SEO social de-dup — full social editor stays in Branding→Social; SEO page keeps only knowledge-graph fields (wikidata/wikipedia) + a redirect note; SEO save scoped so it no longer overwrites Branding social fields.
- **A5** (preview reflecting unsaved embedded nav/footer) — SKIPPED (cross-iframe postMessage, regression risk).

## D-group — Inventory/search/explanations
- **D6** Products-style search bars added to: categories, suppliers, purchase-orders, adjustments, reviews, affiliates, blog (client-side filter; inventory already had server-side). Skipped: pages (no list), returns (hook/table refactor larger than warranted — noted).
- **D2/D4** Shared `HelpTip` component; explanations added for Adjustment Type (all 7 types), GL journal, and Supplier payment terms (EN+AR).

## AI / RLS fixes
- **Platform AI usage** ("Failed to load") — `getPlatformAiUsage` cross-tenant queries wrapped in `withRlsBypass`. ROOT CAUSE: F1 RLS cutover.
- **Reorder scan (D3)** + **Dead-stock scan (D5)** — Inngest jobs wrapped in `withRlsBypass` (were returning empty / duplicating flags because jobs run with no tenant GUC vs newer RLS policies).
- **AI key naming** — added `?? process.env.GEMINI_API_KEY` fallback at all 3 read sites (codebase canonically reads `GOOGLE_GENERATIVE_AI_KEY`).
- **FAQ draft parse** — inline route now uses hardened `parseAiJson` (control-char safe) instead of bare `JSON.parse`.
- **Super-admin RLS sweep (F1 fallout)** — 13 super-admin endpoints restored: stores list, metrics, revenue, subscriptions, affiliate payouts, audit logs, feature flags, provisioning, journals (+ 2 single-store views via `runInTenantContext`).

## Order-page status labels (C1)
- Reverted earlier this session per Ahmad — labels stay accurate Shipped/Delivered (EN) / تم الشحن/تم التسليم (AR). Not renamed.

## Still open / needs Ahmad
- **Confirm Railway env var is `GOOGLE_GENERATIVE_AI_KEY`** (not `GEMINI_API_KEY`) — fallback added but canonical name preferred. If AI still fails, this is why.
- **3 super-admin endpoints left for decision** (still broken until decided): `/admin/export/orders` (streaming cursor — needs per-store chunking, not a single long bypass tx), `/admin/impersonate` (security-sensitive user lookup — wants sign-off), `reconciliation.service.ts` cron (verify job-context GUC wiring first).
- **WBS bot go-live**: set Bot Mode = native_catalog in admin + Meta env (`FORCE_AI_META_BM_ID`, `FORCE_AI_META_ADMIN_TOKEN`) for auto-provision.
- **Live click-test** of: product discount entry+save, reorder/dead-stock AI now returning suggestions, product-page FAQ generate (after env var confirmed).
- Local dev scratch DB (local `.env` still points at prod).
- Autoscaling/replicas (Socket.io redis-adapter + cron leader-election) — infra, separate.
