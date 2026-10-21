# B2B Wholesale Pricing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. PLAN ONLY: no product code ships with this file.

**Goal:** A growing Egyptian brand can sell to resellers on Ebda without leaving for Salla/Zid/Shopify: quantity price breaks per product/variant, customer groups with a group price (percent off, or explicit tier prices), wholesale-only products and a minimum order quantity (MOQ), a shopper-applies / merchant-approves wholesale account flow, and wholesale prices that only an authenticated approved buyer ever receives. Every surface that charges, shows or records a price uses the same server-side resolver, and the invoice shows which tier was applied. Business plan and above by default (Ruling B2B-1).

**Architecture:** One pure function `resolveUnitPrice` in `packages/shared/src/pricing/` (inputs: base price, quantity, buyer group, candidate tiers; output: unit price in piastres + provenance) wrapped by one loader `PriceResolver` in `apps/api/src/services/price-resolver.service.ts` (loads tiers + group, decides the buyer from the AUTHENTICATED user id only). It replaces `cartLineUnitPrice` (`apps/api/src/lib/cart-pricing.ts`) as the single place a charged unit price is decided, the same way `lineAllowsBackorder` replaced six scattered stock reads. Group membership already exists (`CustomerGroup`, `Customer.groupId`); this plan adds pricing fields to the group, a `product_price_tiers` table, MOQ/audience columns on products, a `wholesale_applications` table, and order-line snapshots (`list_price`, `price_source`, `price_tier_min_qty`) so invoices, returns and analytics never re-derive a price. Public product payloads carry only PUBLIC tiers (`group_id IS NULL`); group-specific prices come from a separate authenticated, `no-store` endpoint and are painted client-side so the cached/edge-cached storefront pages stay anonymous-safe.

**Tech Stack:** TypeScript, Zod 3, Prisma 6.19 (strict RLS as `ebda_app`, tenant guard), Express on Cloudflare Workers, Inngest, Next.js 16 (web + admin, next-intl), Vitest 4 (supertest + real Postgres for integration).

**Plan file:** `docs/plans/2026-10-21-b2b-wholesale.md` · branch `feat/b2b-wholesale` (off `main` @ 03f7421c2).

---

## What exists today (mapped 2026-10-21, grep over apps/api, packages/database, apps/admin, apps/web; every claim below was read in the worktree)

The "~9 files mention wholesale/tiers" premise is mostly noise: `wholesale` hits are English idiom ("replace wholesale") in 7 files plus one AI prompt line ("bulk or wholesale orders") and `product.service.ts` "wholesale cost" (= cost price, unrelated). There is NO price-tier, MOQ, wholesale-account or per-group price code. What does exist and is reused:

| Exists | Where | Use here |
| --- | --- | --- |
| Customer groups (CRUD, member assignment by identity, `isDefault` partial unique) | schema `CustomerGroup` (:778), migration `20260721120000_customer_groups`, `customer-group.service.ts`, `customer-groups.routes.ts`, admin `stores/[id]/customer-groups/page.tsx`, customer detail page group picker | Pricing attaches to the group; no new "segment" concept. Schema comment already says the table "exists to unblock group-scoped pricing" and `Customer.groupId` "drives group-scoped pricing" — never built. |
| Group targeting for promotions/coupons | `promotion-targeting.ts`, `promotion-resolver.ts`, `coupon.service.ts`, `coupon.routes.ts:390` | Group is resolved from phone/email of a guest too. **Not reusable for price** (see Ruling B2B-2). |
| One cart-line price function | `apps/api/src/lib/cart-pricing.ts` `cartLineUnitPrice` (variant price ?? product price) with callers in `cart.service`, `order.service`, `bundle.service`, `bundle.routes`, `abandoned-cart.service`, `order-cart-restore`, `mcp/tools/cart.tools` | Becomes a thin wrapper over the resolver, then is deleted. |
| Price reads that bypass it (the real blast radius) | `order.service.ts` ~2791 (`createAdminOrder`: `product.price`/`variant.price`), `payment-links.routes.ts` :303 (own `unitPrice`), `wa-bridge.routes.ts` :193/:326/:741/:754/:1021 (`p.price`, `v.price ?? p.price`), `promotion.routes.ts` :252 (`product.price * qty`), `lib/wishlist-card.ts`, `lib/product-feed.ts`, `mcp/tools/catalog.tools.ts`, `payment-line-items.ts` (reads persisted `OrderItem.price`, fine) | Each is either routed through the resolver or explicitly ruled retail-only (Task 3 table). |
| Money model | `Product.price`/`ProductVariant.price` Int piastres; `OrderItem.price/total/costPrice` snapshots; `Order.taxRateBps`, `taxIncludedInPrice`, VAT base rules (rulings TAX-2, MONEYB-2: subtotal, discounts, shipping, COD fee, VAT, total); `Store.taxEnabled` effective only under a VERIFIED tax profile | VAT already exists. Tiered price enters as the line unit price; no new VAT code (Ruling B2B-6). |
| Plan gating | `packages/shared/src/schemas/plan-limits.ts` (`PlanLimits` booleans such as `abandonedCartAutomation`, plans free/basic/growth/business/pro/comped), `middleware/feature-gate.ts` `PLAN_GATED_FEATURES`, `plan-entitlements.ts`, `features.ts` keys | New boolean limit + feature key `b2b.wholesale`, same pattern as `abandoned_cart`. |
| Caching | `public.routes.ts` PDP: Redis `getCached` for anonymous only (authenticated bypasses Redis) **but `setEdgeCache(sMaxAge 60, swr 300)` is set for every caller including authenticated ones**; `public-cache.ts` `invalidateStoreProductCaches`; web uses `products:<store>` data-cache tags | Hard constraint, see Review Focus 1. |
| Shopper identity | `User` role `customer` (JWT/cookie, `customerUserId(req)`); `Customer` is a separate CRM row keyed by phone/email | Approval bridges User → Customer.groupId. |
| Admin/web surfaces | admin `products`, `customer-groups`, `customers/[customerKey]`, `promotions`, `coupons`; web `products/[slug]`, `cart`, `checkout`, `account`, `lib/coupon-quote-basis.ts` | Edited in Tasks 6-7. |
| Invoices | `invoice.service.ts` (HTML invoice, `col-price`), `fiscal-document*.ts` | Show tier label (Task 8). |

Not modelled today (so out of scope, see Non-goals): buyer tax registration number on invoices, credit terms/net-30, quotes/RFQ, per-group shipping, per-group payment methods, CSV import of tiers.

## Decisions (binding unless Ahmad overrides; each is a Ruling written to docs/RULINGS.md in Task 8)

- **Ruling B2B-1 — Plan gating.** Feature key `b2b.wholesale` ON by default for `business` and `comped`; OFF for `free/basic/growth/pro`; super-admin override per store (existing mechanism). Evidence: Business is the `featureTier: 'enterprise'` plan with 15 staff and unlimited orders; wholesale is a reseller-scale feature. Cost if wrong: a Growth merchant asks to unlock it and a plan seed edit ships.
- **Ruling B2B-2 — Price identity is the authenticated user id, never a typed phone/email.** `resolveCustomerContext` matches a Customer by shipping phone/email and is correct for promotion targeting (a guest typing a VIP's phone gets, at worst, a promo). A PRICE must never work that way: anyone could type a wholesaler's phone at guest checkout and be charged wholesale. The resolver takes `buyerUserId` from the verified session; guests, WhatsApp-bot sessions and payment-link payers are retail unless the merchant creates the order for a named customer in admin. Cost if wrong: a verified-by-WhatsApp wholesaler orders at retail until a later plan adds the WA path.
- **Ruling B2B-3 — Resolution order (most specific wins, then deterministic).** Candidates, after stripping tiers with `minQty > qty`: (1) tier for (variant, group) → (2) (product, group) → (3) (variant, all) → (4) (product, all); within a level the tier with the largest `minQty <= qty`. If no tier: group `percent_off` (basis points) on the base price; else base. Result is clamped to `[0, base]` (a tier above retail is rejected at write time AND clamped at read time) and group percent uses integer round-half-up on piastres (`Math.round(base * (10000 - bps) / 10000)`). Variant price = `variant.price ?? product.price` exactly as today; a product's own sale price is the base. Cost if wrong: a merchant expecting "lowest wins" sees a less-specific cheaper tier lose; the order line records `price_source` so it is explainable.
- **Ruling B2B-4 — Quantity for tier lookup = total quantity of that product (or variant for variant-level tiers) across cart lines in the same cart**, summed after merging note-lines. MOQ is per product, summed across its variants. Cost if wrong: a buyer of 6 + 6 across two sizes is priced as 12 when the merchant meant per-variant; mitigated by a per-tier `scope` is NOT added (YAGNI).
- **Ruling B2B-5 — Coupons and automatic promotions do not apply to lines priced by tier or group (`price_source != 'base'`).** Wholesale margin is already thin; stacking a 20% coupon on a tier price can go below cost. Public (all-buyer) quantity breaks are `price_source = 'tier'` too, so they also exclude coupons. Cost if wrong: a merchant wanting stacking asks for a per-promotion toggle (not built now). Mirrors the existing "a coupon never stacks onto an already-discounted box" bundle rule (Ruling B1).
- **Ruling B2B-6 — VAT.** Egyptian VAT is already modelled; the resolved price is the price on the merchant's existing basis (`taxIncludedInPrice`). Wholesale tiers are entered on the same basis as retail prices (the admin form shows the store's basis next to every price field). No per-group VAT, no reverse charge, no buyer TRN in this plan. Cost if wrong: a merchant who prices wholesale ex-VAT while retail is VAT-inclusive undercharges 14%; the form label and a Review Focus test pin the single basis.
- **Ruling B2B-7 — Wholesale-only products are invisible, not just unpurchasable, to anyone not in an approved wholesale group.** `Product.audience = 'wholesale_only'` removes the product from public list, search, sitemap, feeds, semantic index, recommendations and the WA catalogue for non-approved buyers, and cart-add returns 404 (not 403, no existence oracle). Cost if wrong: a merchant wanted "visible, login to buy"; that is a different flag and a follow-up.

## Global Constraints

- Arabic-first: every merchant- and shopper-facing string in `ar` and `en`; NUMERALS-1: Latin digits in the admin and emails; money through `fromMinor`/`toMinor` from `@ebda/shared` only (no float math on money, no `parseFloat` on prices).
- Money is integer piastres end to end. No new column is `Decimal`/`Float`. Percent discounts are integer basis points.
- **One resolver.** After Task 3 `grep -rn "\.price" apps/api/src` on a charge/display path must hit only the resolver, the snapshot writers, or a line in the Task 3 allow-list test. An architecture test enforces this (see Task 3), the way `no-rls-bypass-in-runtime.test.ts` does for RLS.
- **Never trust a client price.** No request body, query or header carries a price into cart, order, payment link, or WA flows; the server derives it. Existing zod schemas must be asserted to reject/ignore `price`/`unitPrice` keys on the new routes.
- Production has no Redis: `redis.service.ts` is a Cloudflare shim (KV_CACHE for `cache:*` payloads, Durable Object for strong state), so "Redis" below means that layer. Cache staleness class **NEVER-stale** for prices, MOQ, audience, group membership, approval status. Every write path that can change them calls the invalidation in the same transaction-after-commit hook (Task 4 lists them). BOUNDED-stale is NOT used for anything in this plan. An `invalidate*` with zero call-sites fails a test.
- Group-specific prices and wholesale-only products never appear in a cacheable response: no Redis, no `setEdgeCache`, no Next data-cache tag. Responses that vary by buyer send `Cache-Control: private, no-store` and `Vary: Cookie, Authorization`.
- Migrations: additive only, NEVER `lock_timeout`, new tables empty so plain `CREATE INDEX`; new columns nullable or with constant defaults (docs/DB-INDEX-MIGRATIONS.md). Names: `20261028000100_b2b_pricing_tables`, `20261028000200_b2b_product_columns_order_snapshots` (newest migration on ANY branch today is `20261025000100_merchant_webhooks`; re-check `git for-each-ref` + `ls migrations` on every branch before creating, and bump the date prefix if something newer landed).
- RLS: every new table has `store_id`, strict RLS with the canonical 3-branch policy (copy `20260721120000_customer_groups`), tenant-guard classification + regenerated snapshot (`npm run gen:tenant-guard-schema -w packages/database -- --check` exits 0). No `withRlsBypass`/`withOwnerTx` in `apps/api/src`.
- New FK on tenant tables: grep every delete/cascade handler (`ProductService.delete`, `variant.service` delete, `CustomerGroupService.remove`, store-closure, erasure/export) and check `information_schema.referential_constraints` for `NO ACTION` children (Task 1 Step 5).
- Erasure/export: `wholesale_applications` holds PII (business name, phone, commercial reg. no.): it must be in the customer export and erasure paths (`privacy-propagation.service.ts`, `store-closure.service.ts`) — Task 5.
- Route authorization: merchant routes = `authenticate → requireStoreAccess → requireFeature('b2b.wholesale') → rbac`; shopper routes = `customerUserId(req)` required; public price route is read-only and rate-limited.
- commitlint: lowercase subjects, blank line before trailers; `git add` named paths only.
- Storefront copy goes in the `apps/web/src/contexts/LanguageContext.tsx` translations map (EN + AR), never hard-coded in a theme (project rule 3 of Platform-level fixes).
- Platform-level: product-card price display is NOT changed per buyer in v1 (cards show retail / public-tier "from" price on all 8 card paths + Dahab + the 4 hand-built mappers, unchanged); buyer-specific price paints on PDP, cart and checkout only. Recorded as Ruling B2B-9; cost if wrong: a wholesaler sees retail on listing cards until a follow-up threads `BuyerPrice` through every card path.
- Tenant guard: every query on `ProductPriceTier` / `WholesaleApplication` carries a top-level `storeId` in `where`/`data`; use `withSavepoint()` for the unique-race writes (apply twice, tier minQty collision) because the request is one transaction.
- Admin copy only via `useT` (admin i18n guards); en/ar key parity; web copy through the web i18n layer.
- Integration tests are retry-safe (unique ids per call), run against the local Postgres described in the Test environment block.
- Do not weaken a test to make it pass; a failing money test blocks the task.

## Review Focus (money edge cases; each pinned by a named test)

1. **Cache and CDN leak.** An authenticated wholesale request for a PDP/price must never be stored by Redis, the CDN, or a Next data cache, and an anonymous request right after must see retail only. Pinned by `tests/integration/b2b-price-cache-isolation.test.ts`: hit `/public/pricing/resolve` as wholesaler, assert `Cache-Control: private, no-store` and no `s-maxage`; then anonymous `/public/products/:slug` has no group price and no wholesale-only product; assert the existing PDP route no longer calls `setEdgeCache` when `authorization` or the `token` cookie is present (this is a latent defect today).
2. **Typed phone is not identity.** Guest checkout with a wholesaler's phone/email is charged retail. `tests/integration/b2b-price-identity.test.ts`.
3. **Same price everywhere.** For one fixture (product + variant + tier + group %) the unit price is identical across: `GET cart`, add/sync/qty change, `POST orders` (persisted `OrderItem.price` + `total`), admin manual order for that customer, payment link, abandoned-cart recovery totals, `order-cart-restore`, MCP cart tool, promotion preview. `tests/integration/b2b-price-parity.test.ts` drives each and compares to `resolveUnitPrice`.
4. **Tier boundary and qty change.** qty 9 → base, 10 → tier, 10 → 9 reverts; sum-across-variants rule (Ruling B2B-4); qty updated after add re-prices at checkout, not at add time. Pure tests in `packages/shared/src/__tests__/price-resolver.test.ts` (table-driven, property test: price is non-increasing in qty within one level, always `0 <= price <= base`).
5. **Rounding.** Group 12.5% off 9999 piastres → exact integer, half-up, sum of line totals equals order subtotal to the piastre; no lines whose `price * quantity != total`.
6. **Tier edits mid-cart / mid-checkout.** Cart stores quantity only (never a price). Checkout re-resolves inside the order transaction and compares to the amount the payment provider was initialised with; a mismatch aborts before the provider call (reuses the payment-amount guard) — pinned by `b2b-price-parity.test.ts` "tier changed between cart and pay".
7. **MOQ.** Cart add below MOQ is allowed (the shopper builds the cart up) but `POST orders` and payment-link creation refuse with 422 `BELOW_MOQ` naming the product and required qty. v1 MOQ applies to every buyer of that product (no wholesale-only MOQ flag). A line below MOQ can never reach an order through any path (WA bridge included); admin manual order may pass only with the explicit merchant flag `overrideMoq`. Pinned in `b2b-price-parity.test.ts`.
8. **Approval flow abuse.** Applying twice, applying as already-approved, approving cross-store (tenant isolation), revoking approval re-prices open carts to retail at next read, rejected applicant re-applying after 30 days. `tests/integration/b2b-applications.test.ts`.
9. **Wholesale-only existence oracle.** Direct URL, search, sitemap, feed, recommendations, WA catalogue, semantic search results contain no trace for a non-approved buyer (404, not 403). `tests/integration/b2b-wholesale-only-visibility.test.ts` enumerates each surface.
10. **Group delete / unassign / group `isActive=false`** returns members to retail price immediately (NEVER-stale invalidation) and does not delete tiers silently (tiers for a deleted group cascade; deletion shows the count in the confirm UI).
11. **Refund/return math** uses the persisted line `price` (already true: `return.service.ts:430`); a wholesale line refunds at the wholesale unit price. Pinned by an added case in the existing return tests.
12. **VAT.** A VAT-verified store with `taxIncludedInPrice` true and false: tier price flows through the MONEYB-2 base unchanged; invoice VAT equals recomputation from persisted lines.
13. **Plan downgrade.** A store leaving Business keeps its tiers in the DB but the resolver ignores group/tier pricing when `b2b.wholesale` is off (feature read UNCACHED at checkout, like backorder), and wholesale-only products become hidden. Pinned in the parity test.

## Finish line

- **Must work:** merchant sets a 10+ unit price and a "Wholesale" group at 20% off; shopper applies, merchant approves; the approved shopper sees tier/group price on PDP, cart, checkout and the invoice, and is charged exactly that; everyone else sees and pays retail; a wholesale-only product is invisible to others; MOQ is enforced at order.
- **Exercised:** `GET/POST/PUT/DELETE /api/v1/stores/:storeId/products/:productId/price-tiers`, `PUT /customer-groups/:id` (pricing fields), `POST /public/wholesale/apply`, `GET/POST /stores/:storeId/wholesale-applications` (+ `/approve`, `/reject`), `POST /public/pricing/resolve`, public cart add/sync/qty, `POST /public/orders`, admin manual order, payment links, WA bridge catalogue, invoice HTML; web `/products/[slug]`, `/cart`, `/checkout`, `/account/wholesale`; admin product page, customer-groups page, applications queue.
- **Must NOT change:** retail prices and totals for any store without the feature or any buyer outside a priced group (golden parity test over existing order fixtures: totals identical before/after); existing RLS policies; existing coupon/promotion behaviour for base-priced lines; bundle pricing; stock/backorder logic.
- **Done =** every task's test command passes; `npm run typecheck` and `npm run lint` exit 0; tenant-guard check exits 0; the Task 8 blast-radius sweep is stated with its result; after deploy the live checks in Task 8 Step 6 are reported including what could not be verified.

## File structure

| File | Responsibility |
| --- | --- |
| `packages/database/prisma/schema.prisma` + migrations `20261028000100_b2b_pricing_tables`, `20261028000200_b2b_product_columns_order_snapshots` | `ProductPriceTier`, `WholesaleApplication`; `CustomerGroup.pricingMode/discountBps/requiresApproval`; `Product.moq/audience`; `OrderItem.listPrice/priceSource/priceTierMinQty`; `Order.priceGroupName` |
| `packages/database/src/tenant-guard.ts` (+ generated snapshot) | classify new models |
| `packages/shared/src/pricing/resolve-unit-price.ts`, `index.ts` (new) | Pure resolver + types + `PRICE_SOURCES`; zero imports from Prisma |
| `packages/shared/src/__tests__/price-resolver.test.ts` (new) | Table + property tests |
| `packages/shared/src/features.ts`, `plan-baselines.ts`, `schemas/plan-limits.ts` | `b2b.wholesale` key and `wholesalePricing` plan boolean |
| `apps/api/src/middleware/feature-gate.ts` | add `b2b.wholesale: 'wholesalePricing'` to `PLAN_GATED_FEATURES` |
| `apps/api/src/services/price-resolver.service.ts` (new) | Loader: batch-loads tiers/group/feature for a cart or order, returns per-line resolution |
| `apps/api/src/lib/cart-pricing.ts` | thin wrapper, then removed after callers migrate |
| `apps/api/src/services/cart.service.ts`, `order.service.ts` (checkout + `createAdminOrder`), `bundle.service.ts`, `abandoned-cart.service.ts`, `lib/order-cart-restore.ts`, `routes/payment-links.routes.ts`, `routes/wa-bridge.routes.ts`, `routes/promotion.routes.ts`, `mcp/tools/cart.tools.ts`, `mcp/tools/catalog.tools.ts`, `lib/wishlist-card.ts`, `lib/product-feed.ts` | consume the resolver or are ruled retail-only |
| `apps/api/src/services/price-tier.service.ts`, `routes/price-tier.routes.ts` (new) | Merchant tier CRUD + validation (tier <= base, unique minQty per scope) |
| `apps/api/src/services/customer-group.service.ts`, `routes/customer-groups.routes.ts` | pricing fields; invalidation on update/remove/assign |
| `apps/api/src/services/wholesale-application.service.ts`, `routes/wholesale.routes.ts` (new) | apply / list / approve / reject / revoke; notification emails |
| `apps/api/src/routes/public.routes.ts`, `lib/edge-cache.ts` | public tiers in payload, `POST /public/pricing/resolve`, no edge cache for authenticated callers, wholesale-only filter |
| `apps/api/src/services/product.service.ts`, `product-index.service.ts`, `product-search.service.ts`, `recommendation.service.ts` | `audience` filtering + MOQ/audience fields |
| `apps/api/src/lib/public-cache.ts` | `invalidateStoreProductCaches` call from every tier/group/approval write |
| `apps/api/src/services/invoice.service.ts`, `fiscal-document-render.ts`, `analytics.service.ts` | tier label on invoice, wholesale revenue split |
| `apps/web/src/app/products/[slug]/*`, `components/pricing/TierTable.tsx`, `BuyerPrice.tsx` (new), `cart/CartClient.tsx`, `checkout/*`, `app/account/wholesale/page.tsx` (new), `lib/api.ts` | storefront |
| `apps/admin/src/app/stores/[id]/products/**` (tier editor, MOQ, audience), `customer-groups/page.tsx`, `wholesale-applications/page.tsx` (new), `components/admin-layout/hubs.ts`, `i18n/messages/{en,ar}.json` | merchant UI |
| `tests/integration/b2b-*.test.ts`, `tests/unit/b2b-*.test.ts` (new) | proofs named in Review Focus |
| `docs/RULINGS.md`, `docs/merchant/faq.md`, `docs/api/*`, `docs/ebda/*`, `CLAUDE.md` plan table if it lists features | docs |

### Test environment (every integration step)

```bash
export DATABASE_URL=postgresql://test:${TEST_DB_PASSWORD}@localhost:5432/force_test
export DIRECT_URL=$DATABASE_URL
export NODE_ENV=test
npx prisma migrate deploy --schema packages/database/prisma/schema.prisma
psql "$DATABASE_URL" -c "ALTER ROLE ebda_app LOGIN PASSWORD 'ci-only-app-pw'"
```

Unit: `npx vitest run <file>`. Integration: `npx vitest run tests/integration/<file>`.

## Lean-mode notes (execution, not product)

- Implementers: `model: "sonnet"` per task (all tasks are spec-driven). One review per task, run by a fresh Sonnet reviewer against this file's task text, not a two-stage review.
- **Opus only twice:** (a) design review of the pricing resolver at the end of Task 2 (Rulings B2B-2/3/4, the pure function, its property tests, and the loader's identity rule) — the gate before Task 3 starts; (b) the final PR review of the whole branch against Review Focus 1-13.
- Tasks 1 → 2 → 3 are strictly sequential (money core). Tasks 4, 5, 6, 7 may run after Task 3, at most one at a time per the 1-2 worker rule; Task 8 last.
- Per-commit: update the session handoff; run the memory pipeline after each commit.
- Do not dispatch more than one implementer concurrently; no sibling worktrees on the same migration directory.

---

### Task 1: Schema, migrations, RLS, tenant guard, plan gate

**Files:**
- Modify: `packages/database/prisma/schema.prisma`
- Create: `packages/database/prisma/migrations/20261028000100_b2b_pricing_tables/migration.sql`
- Create: `packages/database/prisma/migrations/20261028000200_b2b_product_columns_order_snapshots/migration.sql`
- Modify: `packages/database/src/tenant-guard.ts` (+ regenerated snapshot)
- Modify: `packages/shared/src/features.ts`, `packages/shared/src/plan-baselines.ts`, `packages/shared/src/schemas/plan-limits.ts`
- Modify: `apps/api/src/middleware/feature-gate.ts`
- Test: `packages/shared/src/__tests__/features.test.ts`, `packages/shared/src/__tests__/plan-baselines.test.ts`, `tests/integration/b2b-rls.test.ts` (new)

**Interfaces (exact):**
- `ProductPriceTier { id uuid, storeId, productId, variantId?, groupId?, minQty Int (>=2), priceMinor Int (>=0), createdAt, updatedAt }`. Unique `(productId, variantId, groupId, minQty)` implemented as a unique index on `(product_id, COALESCE(variant_id, zero-uuid), COALESCE(group_id, zero-uuid), min_qty)` (Prisma cannot express it; follow the `cart_items` partial-index precedent in the schema comments). Indexes: `(store_id, product_id)`, FK-only indexes on `variant_id` and `group_id`. FKs: product CASCADE, variant CASCADE, group CASCADE, store CASCADE.
- `CustomerGroup` += `pricingMode String @default("none")` (`none|percent_off`), `discountBps Int @default(0)` (CHECK 0..9000), `requiresApproval Boolean @default(false)`, `isWholesale Boolean @default(false)` (only wholesale groups unlock `wholesale_only` products and the application flow). Constant defaults, so no table rewrite.
- `Product` += `moq Int?` (CHECK null or >=2), `audience String @default("public")` (`public|wholesale_only`). Index `(store_id, audience)` only if the Task 6 listing query plans need it (verify with EXPLAIN in the test DB, otherwise skip: `skip: <reason>`).
- `WholesaleApplication { id, storeId, userId, businessName, commercialRegNo?, phone, notes?, status 'pending'|'approved'|'rejected'|'revoked', groupId? (assigned on approval), decidedBy?, decidedAt?, decisionNote?, createdAt, updatedAt }`. Partial unique `(store_id, user_id) WHERE status = 'pending'` (one open application). Index `(store_id, status, created_at)`.
- `OrderItem` += `listPrice Int?`, `priceSource String?` (`base|tier|group`), `priceTierMinQty Int?`. `Order` += `priceGroupName String?` (snapshot, so a renamed/deleted group does not rewrite history). All nullable: orders placed before this read as `base`.
- Feature key `b2b.wholesale`; `PlanLimits.wholesalePricing: boolean` (false for free/basic/growth/pro, true for business/comped; the zod schema gets `.default(false)` so a stored `limits` blob without the key still parses — the corrupt-blob fallback in `parseLimits` must not flip to unlimited).

- [ ] **Step 1:** Write the failing tests: `b2b-rls.test.ts` (store A cannot read/insert store B tiers or applications as `ebda_app`; contextless sees none, on an UNGUARDED ebda_app client like `rls-ebda-app.test.ts`), plus feature/plan tests (`b2b.wholesale` exists, business true, growth false, a limits blob missing the key parses to false). Expected: fail (no tables/key).
- [ ] **Step 2:** Edit schema + write both migrations as plain DDL (no `IF NOT EXISTS`, repo convention), RLS block copied from `20260721120000_customer_groups`, CHECK constraints for ranges, header comment naming the latest prior migration (`20261025000100_merchant_webhooks`) and why these two files are split (tables vs. columns on hot tables, so the second can be reverted alone).
- [ ] **Step 3:** Classify `product_price_tiers` and `wholesale_applications` in tenant guard; run `npm run gen:tenant-guard-schema -w packages/database -- --check` (regenerate then re-check).
- [ ] **Step 4:** Add the feature key, plan boolean, `PLAN_GATED_FEATURES` entry; update plan seeds/baselines tests.
- [ ] **Step 5 (FK sweep):** list every delete/cascade handler touching products, variants, customer groups, users, stores (`ProductService.delete`, `variant.service`, `CustomerGroupService.remove`, `store-closure.service`, `privacy-propagation.service`, user erasure) and query `information_schema.referential_constraints` for `NO ACTION` children of the new FKs in the test DB; state the result.
- [ ] **Step 6:** Run: `npx vitest run tests/integration/b2b-rls.test.ts packages/shared/src/__tests__/features.test.ts packages/shared/src/__tests__/plan-baselines.test.ts`, `npm run typecheck`. Expected: pass.
- [ ] **Step 7:** Commit `feat(b2b): pricing tables, product moq/audience, plan gate`.

### Task 2: The pricing resolver (pure function + loader) — Opus design review gate

**Files:**
- Create: `packages/shared/src/pricing/resolve-unit-price.ts`, `packages/shared/src/pricing/index.ts`
- Modify: `packages/shared/src/index.ts` (export)
- Create: `apps/api/src/services/price-resolver.service.ts`
- Modify: `apps/api/src/lib/cart-pricing.ts` (becomes a wrapper delegating to the pure function with no tiers/group, marked `@deprecated`, so existing callers keep behaving until Task 3)
- Test: `packages/shared/src/__tests__/price-resolver.test.ts`, `tests/unit/price-resolver-service.test.ts`, `tests/integration/b2b-price-identity.test.ts`

**Interfaces (exact):**
```ts
export type PriceSource = 'base' | 'tier' | 'group';
export interface PriceTierRow { variantId: string | null; groupId: string | null; minQty: number; priceMinor: number }
export interface ResolveInput {
  baseMinor: number;                 // variant.price ?? product.price
  qty: number;                       // already summed per Ruling B2B-4
  variantId: string | null;
  buyerGroup: { id: string; pricingMode: 'none' | 'percent_off'; discountBps: number; isActive: boolean } | null;
  tiers: readonly PriceTierRow[];    // only this product's rows
}
export interface Resolved { unitMinor: number; source: PriceSource; tierMinQty: number | null; listMinor: number }
export function resolveUnitPrice(i: ResolveInput): Resolved;   // pure, total, never throws on valid ints; throws RangeError on non-integer/negative input
```
Loader: `PriceResolver.forBuyer(storeId, buyerUserId | null)` returns `{ priceLine(productLike, variantLike|null, qty): Resolved; priceCart(lines): Map<lineKey, Resolved> }`; batch-loads tiers for all product ids in ONE query, the buyer's group via `User → Customer(phone/email) → groupId` ONLY when `buyerUserId` is set, and `featureService.isFeatureEnabled(storeId,'b2b.wholesale')` UNCACHED when any tier/group exists (if off → `base`). Group not `isActive` or not matching the store → retail. Loader result is memoised per request only.

- [ ] **Step 1:** Write failing table tests for every Ruling B2B-3 level and boundary; property tests (fast-check if already a dev dependency, otherwise a seeded loop of 2,000 cases): `0 <= unit <= base`, monotone non-increasing in qty within a level, `listMinor == baseMinor`, idempotent.
- [ ] **Step 2:** Implement the pure function. No Prisma/Date/random imports (lint rule `no-restricted-imports` on the folder).
- [ ] **Step 3:** Write failing loader tests: guest = base; authenticated non-member = base; approved wholesaler = group price; typed phone in `x-` headers/body ignored (Ruling B2B-2); feature off = base; inactive group = base; cross-store group id = base.
- [ ] **Step 4:** Implement loader + `cartLineUnitPrice` wrapper (returns `listMinor` semantics unchanged).
- [ ] **Step 5:** `npx vitest run packages/shared/src/__tests__/price-resolver.test.ts tests/unit/price-resolver-service.test.ts tests/integration/b2b-price-identity.test.ts`; `npm run typecheck`. Expected: pass.
- [ ] **Step 6:** Commit `feat(b2b): single server-side price resolver`.
- [ ] **Step 7 (gate):** Opus design review of Task 2 only (resolver purity, identity rule, rounding, clamp, tests really able to fail — mutate the tie-break and the clamp and confirm a test goes red). Task 3 does not start until it signs off.

### Task 3: Wire every charging, displaying and recording path to the resolver

**Files (modify):** `apps/api/src/services/cart.service.ts` (computeTotals + add/sync/qty/restore at :438/:751/:853/:993), `apps/api/src/services/order.service.ts` (checkout create ~1590-1650, `createAdminOrder` ~2791, VAT base ~946/1144/2977), `apps/api/src/services/bundle.service.ts` + `routes/bundle.routes.ts` (components priced at BASE: bundles are explicitly not tiered, Ruling B2B-8 below), `apps/api/src/services/abandoned-cart.service.ts`, `apps/api/src/lib/order-cart-restore.ts`, `apps/api/src/routes/payment-links.routes.ts` (:303), `apps/api/src/routes/wa-bridge.routes.ts` (:193/:326/:741/:754/:1021), `apps/api/src/routes/promotion.routes.ts` (:252), `apps/api/src/mcp/tools/cart.tools.ts`, `apps/api/src/mcp/tools/catalog.tools.ts`, `apps/api/src/lib/wishlist-card.ts`, `apps/api/src/lib/product-feed.ts`, `apps/api/src/lib/payment-line-items.ts` (verify unchanged), `apps/api/src/services/coupon.service.ts` (Ruling B2B-5 exclusion), `apps/api/src/services/promotion.service.ts` / `promotion-resolver.ts`.
**Test:** `tests/integration/b2b-price-parity.test.ts`, `tests/unit/b2b-no-direct-price-reads.test.ts` (architecture guard), existing suites for each touched service (cart, order, payment-links, wa-bridge, coupon, promotion, abandoned-cart, bundle).

- **Ruling B2B-8 (bundles):** bundle component sums and bundle prices stay retail/base; bundles are a separate merchant-set price. Cost if wrong: a wholesaler buys a bundle at retail; one line in the admin bundle form says so.

Path decisions (each ends done(evidence) or `skip: <reason>`):

| Path | Decision |
| --- | --- |
| Cart read/add/sync/qty | resolver, buyer = `customerUserId(req)`; cart still stores qty only |
| Checkout `OrderService.create` | resolver INSIDE the order transaction; writes `price`, `total`, `listPrice`, `priceSource`, `priceTierMinQty`; `Order.priceGroupName`; MOQ check (422 `BELOW_MOQ`) before stock reserve |
| Payment init | amount computed from the persisted order (unchanged); add the "re-resolve equals persisted" assert for tier edits between cart and pay |
| Admin manual order | buyer = the chosen customer's linked user/group, else retail; `overrideMoq` explicit flag |
| Payment links | buyer = link's named customer if any (admin-created), else retail; MOQ enforced |
| WA bridge | retail + PUBLIC tiers only (Ruling B2B-2, group never resolved); wholesale-only products excluded |
| Abandoned cart / restore / MCP cart | resolver with the cart owner's user id |
| Promotion preview | resolver-priced lines; excluded from discount basis if `source != 'base'` (Ruling B2B-5) |
| Coupons (`coupon.service`, checkout apply) | basis = base-priced loose lines only; web `coupon-quote-basis.ts` mirrors (add `excludedFromCoupon` flag on cart lines, test real arithmetic) |
| Feeds, wishlist card, catalog MCP | retail + public tiers (anonymous-safe) |
| Returns/refunds | unchanged: persisted `OrderItem.price` (assert in a test) |

- [ ] **Step 1:** Write `b2b-no-direct-price-reads.test.ts`: scans `apps/api/src/**` for `.price`/`unitPrice` reads in files on the charge/display list and fails on any not in a reviewed allow-list with a one-line reason per entry; red first (lists today's offenders: `order.service.ts:2791`, `payment-links.routes.ts:306`, `wa-bridge.routes.ts`, `promotion.routes.ts:252`).
- [ ] **Step 2:** Write failing `b2b-price-parity.test.ts` cases for Review Focus 3, 5, 6, 7, 12, 13 and the golden "no feature ⇒ identical totals" case over existing fixtures.
- [ ] **Step 3:** Migrate paths in dependency order: cart → order create → admin order → payment links → abandoned cart/restore/MCP → promotions/coupons → WA/feeds/wishlist/catalog.
- [ ] **Step 4:** Remove the `cartLineUnitPrice` wrapper once no caller remains (grep to zero), or keep as the base-only function under a new honest name if bundle code needs it.
- [ ] **Step 5:** `npx vitest run tests/integration/b2b-price-parity.test.ts tests/unit/b2b-no-direct-price-reads.test.ts` plus every existing test file of the touched services (list them by `ls tests/unit tests/integration | grep -E "cart|order|payment-link|wa-bridge|coupon|promotion|abandoned|bundle|return"`), `npm run typecheck`. Expected: all pass.
- [ ] **Step 6:** Commit `feat(b2b): route every price path through the resolver`.

### Task 4: Merchant pricing APIs and NEVER-stale invalidation

**Files:**
- Create: `apps/api/src/services/price-tier.service.ts`, `apps/api/src/routes/price-tier.routes.ts`; register in `routes/index.ts`
- Modify: `customer-group.service.ts` + `customer-groups.routes.ts` (pricing fields, `requiresApproval`, `isWholesale`), `product.service.ts` + `product.routes.ts` (`moq`, `audience`, strip them from the cached public payload except public tiers), `variant.service.ts`, `bulk.service.ts` / `lib/inngest/functions/bulk-import.ts` (price edits must invalidate tiers' dependents; tiers above the NEW base price are flagged, not silently clamped)
- Modify: `apps/api/src/lib/public-cache.ts` only if a tier-specific key is added (prefer reusing `invalidateStoreProductCaches`)
- Test: `tests/integration/b2b-price-tier-api.test.ts`, `tests/integration/b2b-cache-invalidation.test.ts`, `tests/unit/b2b-invalidate-callsites.test.ts`

Rules: tier `priceMinor <= current base` at write time (422 `TIER_ABOVE_BASE`), `minQty >= 2`, unique per scope (409), variant must belong to product, group must belong to store and `isWholesale`-or-any (v1 any group), max 10 tiers per product/scope (anti-abuse), zod rejects any unknown key. Base-price edits that leave a tier above base return a warning list and the resolver clamp keeps charging correct meanwhile.

Invalidation write paths (each must call `invalidateStoreProductCaches` after commit; the unit test enumerates them and fails if a call-site is missing or an `invalidate*` has zero callers): tier create/update/delete; product update (`moq`, `audience`, price); variant create/update/delete (price); product delete/restore; bulk import/bulk edit/AI bulk jobs that change price; customer-group update (pricing fields, `isActive`, `isWholesale`), group delete, member assign/unassign (these three also drop any per-buyer memo — there is none cached; state `no per-buyer cache exists`); application approve/reject/revoke; plan change and super-admin feature override for `b2b.wholesale` (FeatureService cache already busts on override writes; add the plan-change path).

- [ ] **Step 1:** Failing tests: API validations; cache test (read PDP twice, edit tier, read again within TTL sees the new public tier, Redis key gone); the call-site enumeration test.
- [ ] **Step 2:** Implement services/routes with `requireFeature('b2b.wholesale')` and merchant RBAC; audit-log entries consistent with other merchant writes.
- [ ] **Step 3:** Add invalidation at each path above; the unit test is the ledger.
- [ ] **Step 4:** `npx vitest run tests/integration/b2b-price-tier-api.test.ts tests/integration/b2b-cache-invalidation.test.ts tests/unit/b2b-invalidate-callsites.test.ts`; typecheck.
- [ ] **Step 5:** Commit `feat(b2b): tier and group pricing apis with invalidation`.

### Task 5: Wholesale account application and approval

**Files:**
- Create: `apps/api/src/services/wholesale-application.service.ts`, `apps/api/src/routes/wholesale.routes.ts` (public shopper routes + merchant routes), email templates `apps/api/src/services/email-templates/wholesale-{received,approved,rejected}.ts` (bilingual Arabic first, brand strings from `BRAND`)
- Modify: `customer-group.service.ts` (reuse `assignByIdentity` for approval), `privacy-propagation.service.ts` + customer export/erasure + `store-closure.service.ts` (applications are PII), `routes/index.ts`
- Test: `tests/integration/b2b-applications.test.ts`, `tests/integration/b2b-applications-privacy.test.ts`

Flow: signed-in shopper `POST /public/wholesale/apply {businessName, commercialRegNo?, phone, notes?}` (zod, rate-limited, one open application per user/store, 30-day re-apply cooldown after rejection) → status `pending` + merchant notification (existing notification dispatcher) → merchant `POST /stores/:storeId/wholesale-applications/:id/approve {groupId}` (group must be `isWholesale` and belong to the store) inside one transaction: upsert `Customer` by the user's verified identity, set `groupId`, mark application `approved` with `decidedBy` → invalidation → email. `reject {note}`; `revoke` returns the customer to the store's default group or none (NEVER-stale invalidation). If a group has `requiresApproval = false`, a shopper may self-join via apply with auto-approve (v1: NOT built; the flag is stored for the admin form only if Ahmad wants it, see Questions).
Shopper status: `GET /public/wholesale/status` (own application, `no-store`). Approval emails go to the applicant's account email only.

- [ ] **Step 1:** Failing tests for Review Focus 8 (double apply, cross-store approve 404, non-wholesale group 422, revoke re-prices, cooldown) and privacy export/erasure presence.
- [ ] **Step 2:** Implement service + routes + templates (all failure paths fail fast: if the approval email enqueue throws, the approval stays valid and the row records `notify_failed`; the DB-write + irreversible external call rollback rule does not apply because email is not irreversible-critical — state this `skip: <reason>` in the commit).
- [ ] **Step 3:** `npx vitest run tests/integration/b2b-applications.test.ts tests/integration/b2b-applications-privacy.test.ts`; typecheck.
- [ ] **Step 4:** Commit `feat(b2b): wholesale application and approval flow`.

### Task 6: Storefront API and web (anonymous-safe pages, buyer-specific paint)

**Files:**
- Modify: `apps/api/src/routes/public.routes.ts` (public payload adds `moq` and public tiers; authenticated PDP/list responses send `Cache-Control: private, no-store` and skip `setEdgeCache`; new `POST /public/pricing/resolve {items:[{productId,variantId?,qty}]}` → resolved unit prices for the signed-in buyer, max 50 items, `no-store`), `product.service.ts` / `product-index.service.ts` / `product-search.service.ts` / `recommendation.service.ts` / sitemap + feed builders (wholesale-only filtering, Ruling B2B-7; the semantic index must not embed wholesale-only products into the shared index, or must filter on `audience` at query time — pick query-time filter, state the reason), `lib/edge-cache.ts` (helper `setBuyerPrivate(res)`)
- Create: `apps/web/src/components/pricing/TierTable.tsx`, `BuyerPrice.tsx`, `apps/web/src/app/account/wholesale/page.tsx`
- Modify: `apps/web/src/app/products/[slug]/*` (render public tiers + MOQ; `BuyerPrice` client component fetches `/public/pricing/resolve` with `cache: 'no-store'` and replaces the price), `apps/web/src/app/cart/CartClient.tsx`, `apps/web/src/app/checkout/CheckoutClient.tsx` (display server prices only; show tier badge and the MOQ error), `apps/web/src/lib/api.ts`, `apps/web/src/lib/coupon-quote-basis.ts` (exclude non-base lines)
- Test: `tests/integration/b2b-price-cache-isolation.test.ts`, `tests/integration/b2b-wholesale-only-visibility.test.ts`, web component tests (`TierTable`, `BuyerPrice`, cart MOQ message, Arabic RTL), `apps/web/src/lib/coupon-quote-basis` unit test

- [ ] **Step 1:** Failing tests: Review Focus 1 and 9; component tests assert Latin digits, `dir` correct in `ar`, no price flashes of wholesale price in SSR HTML (the server HTML contains retail only).
- [ ] **Step 2:** Implement API changes; fix the latent edge-cache-on-authenticated defect (the class, per rule C: grep every `setEdgeCache` call and every route reading `authorization`/`token` — cart, account, wishlist — and fix siblings in one pass).
- [ ] **Step 3:** Implement web components and pages; Arabic first copy via the web i18n layer.
- [ ] **Step 4:** `npx vitest run tests/integration/b2b-price-cache-isolation.test.ts tests/integration/b2b-wholesale-only-visibility.test.ts` + the web test files; `npm run typecheck`.
- [ ] **Step 5:** Drive it: with a local API + web (only if allowed in that session; this planning session ran no servers), apply as a shopper, approve, view PDP/cart/checkout as wholesaler and anonymous in Arabic and English, screenshot. If not run, the PR says NOT VERIFIED for browser flow.
- [ ] **Step 6:** Commit `feat(b2b): storefront tiers, moq and buyer-specific prices`.

### Task 7: Admin UI

**Files:**
- Modify: `apps/admin/src/app/stores/[id]/products/**` (price-tier editor: table of qty / price with the store's VAT-basis label, group selector, variant selector, live "margin vs cost" hint from `costPrice` if present; MOQ field; audience toggle), `customer-groups/page.tsx` (pricing mode, discount %, wholesale flag), `customers/[customerKey]/page.tsx` (shows group + price source), `components/admin-layout/hubs.ts` + `AdminLayout.tsx` (new tab "Wholesale applications" under the customers hub), `i18n/messages/en.json`, `ar.json`
- Create: `apps/admin/src/app/stores/[id]/wholesale-applications/page.tsx` (queue: pending/approved/rejected, approve with group picker, reject with note, revoke), `_components/*`
- Plan gate UI: when `b2b.wholesale` is off show the upgrade prompt used by other gated features rather than hiding fields silently.
- Test: component tests (jsdom) for the tier editor validation (above-base rejected client-side too, but server is the authority), the applications page, `admin-i18n-*` guards (ar/en parity, `useT` only), a11y pass.

- [ ] **Step 1:** Failing component and i18n tests.
- [ ] **Step 2:** Implement with the existing admin components; no new design system.
- [ ] **Step 3:** `npx vitest run apps/admin/...` for the new tests + `tests/unit/admin-i18n-*.test.ts`; typecheck; lint.
- [ ] **Step 4:** Commit `feat(b2b): admin pricing tiers, group pricing, applications queue`.

### Task 8: Invoices, analytics, docs, rulings, blast-radius, live verification

**Files:**
- Modify: `apps/api/src/services/invoice.service.ts` (+ `fiscal-document-render.ts`): under each line show the tier label ("Wholesale price, 10+ units" / "سعر الجملة، ١٠+" — Latin digits per NUMERALS-1) from the persisted snapshot, never re-resolved; list price struck through only if `priceSource != 'base'`. `analytics.service.ts`: wholesale vs retail revenue split by `priceSource` (read-only, additive). Order detail in admin shows the group name snapshot.
- Docs: `docs/RULINGS.md` (B2B-1..8 with `Cost if wrong:`), `docs/merchant/faq.md` (how to set tiers, approve buyers, why a coupon does not apply), `docs/api/` (new routes), `docs/ebda/` plan-feature matrix (Business row), `docs/runbooks/` short "support: a wholesaler sees retail price" checklist, ROADMAP/PRODUCT if they list B2B as a gap.
- Test: invoice snapshot tests (tier line renders, old order without snapshot renders unchanged), analytics test.

- [ ] **Step 1:** Failing invoice/analytics tests.
- [ ] **Step 2:** Implement; regenerate plan-feature matrix from code.
- [ ] **Step 3:** Docs and rulings in the same PR (documentation parity).
- [ ] **Step 4 (blast-radius sweep):** one pass over every touched identifier: `price`, `unitPrice`, `cartLineUnitPrice`, `customerGroupId`, `groupId`, `moq`, `audience`, `listPrice`, `priceSource`, `b2b.wholesale`, `wholesalePricing`, `product_price_tiers`, `wholesale_applications`, the migration names, across `apps/*`, `packages/*`, `tests/*`, `loadtests/`, `scripts/`, CI workflows, `docs/`, `.env.example`, MCP tool schemas, the WA bot, the marketing site pricing page. State the result in the PR: `blast-radius: swept <ids> across <scopes> → clean` or `→ found + fixed N`.
- [ ] **Step 5:** Full gates: `npm run typecheck`, `npm run lint`, `npx vitest run tests/unit`, the integration files named above, tenant-guard `--check`, `npm audit` baseline unchanged (no new dependency is added by this plan; `skip: no dependency added`). A k6 smoke on `/public/pricing/resolve` and cart read with 50 lines, p95 < 500 ms, numbers through `benchmark-vet` before reporting.
- [ ] **Step 6 (after deploy, PROD verification):** `curl /health` commit equals `main` tip for API AND the `cf-deploy` web/admin run for the same commit (enumerate every pipeline the merge triggers). Read-only SQL: new tables exist, RLS enabled. With a staging/test store on Business: anonymous PDP shows retail only (`curl` + check no `s-maxage` on authenticated responses), wholesaler cart shows tier (guest-shaped cart only; do NOT complete a purchase without asking). Check Arabic locale. Report what could not be verified (e.g. real payment at wholesale price, WhatsApp path).
- [ ] **Step 7:** Commit `docs(b2b): rulings, faq, invoice tier label`. Then the final Opus PR review against Review Focus 1-13.

---

## Non-goals (v1)

Buyer TRN/B2B tax invoices and reverse charge, credit terms/net-N and invoicing-later, quotes/RFQ, per-group shipping or payment methods, CSV import/export of tiers, per-promotion stacking toggle, MOQ per variant or case-pack multiples, tiered pricing on bundles, store-wide "login to see prices" for the public catalogue, wholesale prices over WhatsApp.

## Questions that need Ahmad

1. **Plan gate:** Business + comped only (Ruling B2B-1), or also Growth? (Growth is the plan most Egyptian growing brands buy; gating it up is a revenue lever, opening it down is an acquisition lever.)
2. **Coupons on wholesale lines:** exclude (Ruling B2B-5, default) or allow stacking?
3. **"Prices only to logged-in approved buyers":** is it per product (wholesale-only products, Ruling B2B-7) or do you also want a store-wide "login to see prices" mode for the whole catalogue? The second hides prices from Google/feeds and has SEO and ad-platform consequences, so it is NOT in this plan unless you say so.
4. **Self-serve vs approval:** all wholesale groups require merchant approval (planned), or should a merchant be able to let anyone self-join a group (auto-approve)?
