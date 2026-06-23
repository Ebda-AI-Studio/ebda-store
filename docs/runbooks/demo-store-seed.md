# Demo Store Seed — Runbook

## Overview

`packages/database/prisma/seed-demo-store.ts` creates (or fully refreshes) a
single rich demo store used for admin-dashboard tutorial video recording and
feature demonstrations. It is **idempotent** — you can run it as many times as
you like against production without fear of duplicate data or touching any
other store.

## What It Creates

| Resource        | Count / Detail                                                                                                                                                                                                                            |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Store           | 1 · slug `demo` · plan `enterprise` · template `modern` · KWD                                                                                                                                                                             |
| Feature flags   | All 37 flags ON (loyalty, reviews, blog, affiliate, accounting, …)                                                                                                                                                                        |
| Categories      | 6 bilingual categories with positions + `showOnHomeStrip` mix                                                                                                                                                                             |
| Products        | ~25 total — spread across all 5 variant shapes (see below)                                                                                                                                                                                |
| Customers       | 10 sample Kuwait-named customers                                                                                                                                                                                                          |
| Orders          | 19 orders covering every `OrderStatus` + COD / online payment mixes                                                                                                                                                                       |
| Reviews         | ~15 product reviews (varied ratings, some pending moderation)                                                                                                                                                                             |
| Loyalty records | 5 (bronze / silver / gold tiers)                                                                                                                                                                                                          |
| Coupons         | 3 (WELCOME10 / SAVE5KD / FREESHIP)                                                                                                                                                                                                        |
| Blog posts      | 6 bilingual posts — welcome, electronics guide, home decor, skincare, gift guide, wellness                                                                                                                                                |
| Store pages     | 6 bilingual pages — About, Contact, Shipping, Returns, Privacy, Terms (full content blocks)                                                                                                                                               |
| FAQ entries     | 8 bilingual FAQs — delivery, returns, COD, tracking, order change, warranty, gift wrap, loyalty                                                                                                                                           |
| Store locations | 2 branches — Kuwait City main + Salmiya east (hours, phone, WhatsApp, maps link)                                                                                                                                                          |
| HowTo           | 1 entry — "How to Place an Order" (6 bilingual steps)                                                                                                                                                                                     |
| layoutSettings  | Fully populated: kicker/subtitle on every carousel section, 2 extra carousels (Editor's Picks + Staff Spotlight manual), per-page bgColor/density for products/PDP/categories/locations/checkout/cart, sectionOrder, blogCarousel enabled |

### Every-subsystem enrichment (added 2026-06-23, `feat/demo-store-full-seed`)

On top of the base data above, the seed now populates EVERY remaining subsystem so
that any admin page or storefront surface shows real, believable rows ("every data
has a UI"). Each block is wrapped in `try/catch` + `console.log` so one schema
mismatch can never abort the rest, and each is delete-then-recreate idempotent
scoped to the `demo` store only.

| Subsystem                 | What it seeds                                                                                                                                                                                                      |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Registered customers      | 10 `User` (role=customer) accounts (`customerN@demo.forcemediakw.com`, password `DemoPass123!`) — back wishlists, returns, RFM. Existing orders are linked to these.                                               |
| Product cost prices       | `costPrice` set to ~55% of price on all products → drives COGS / P&L / margin / dead-stock value.                                                                                                                  |
| **Accounting — chart**    | 14-account chart of accounts (asset / liability / equity / revenue / expense) with a couple of children + `isSystem` flags.                                                                                        |
| **Accounting — journal**  | 10 balanced journal entries (debits == credits, in fils): opening balance, sales revenue + matching COGS, a refund, a `reversed` entry, a `draft` entry. Posted by the store owner.                                |
| **Accounting — expenses** | 6 expenses across rent / marketing / utilities / salaries in `posted` / `approved` / `pending` / `draft` states.                                                                                                   |
| **Accounting — FX**       | 2 FX rate registry rows (USD / EUR → KWD) for `accounting.multi_currency`.                                                                                                                                         |
| **Bank reconciliation**   | 1 bank statement (`reconciling`) + 4 transactions: 2 matched (auto + manual) to journal entries, 2 unmatched → the reconciliation mismatch report has content.                                                     |
| **Inventory — suppliers** | 3 suppliers with lead-time + payment terms (net15 / net30 / net60).                                                                                                                                                |
| **Inventory — POs**       | 4 purchase orders in `draft` / `sent` / `partial` / `received` states with line items + partial receipts.                                                                                                          |
| **Inventory — adjust.**   | 3 stock adjustments (damage write-off + found, both posted; a draft cycle-count) with before/after qty + value impact.                                                                                             |
| **Inventory — reorder**   | 3 reorder rules + 3 live reorder suggestions (advisory smart-layer) + 1 dead-stock flag + 1 backorder line + 1 profit anomaly (margin-drop warning).                                                               |
| **Inventory — counts**    | 1 closed cycle-count session with 3 count lines (incl. a variance).                                                                                                                                                |
| **Warehouses**            | 2 warehouses (Shuwaikh main + Salmiya depot) + 16 per-warehouse stock rows (`inventory.multi_warehouse`).                                                                                                          |
| **Inventory history**     | 19 movement-ledger rows spanning initial / sale / return_stock / manual_add / damage / adjustment.                                                                                                                 |
| **Order scenarios**       | Existing 19 orders re-dated across ~90 days (analytics/cohorts/funnel/RFM) + linked to registered customers; plus a FAILED-payment order and a STUCK/UNPAID gateway-abandoner order (Enterprise retargeting list). |
| **Payment events**        | 6 append-only payment-lifecycle events (created → webhook → completed/failed) including a settlement id and a failure reason.                                                                                      |
| **Partial refund**        | One delivered+paid order's payment moved to `partially_refunded` (40%) with a `refund` payment event.                                                                                                              |
| **Returns**               | 5 returns, one in each meaningful status (pending / approved / received / completed / rejected) with return items + reasons + refund/rejection metadata.                                                           |
| **Shipments**             | 1 Aramex carrier config + up to 5 shipments (tracking #, URL, status history) for shipped/delivered orders.                                                                                                        |
| **Abandoned carts**       | Config row + 4 abandoned carts (pending / contacted ×2 / recovered) each with a real `Cart` + items and stepped reminder timestamps.                                                                               |
| **Wishlists**             | 5 customer wishlists with 15 saved-product items.                                                                                                                                                                  |
| **Loyalty txns**          | 11 extra loyalty transactions on top of the base earn rows: redeem-discount (negative), review bonus, signup bonus — both directions + tiers.                                                                      |
| **Analytics snapshots**   | 6 cohort snapshots, 14 funnel snapshots (last 14 days), 10 RFM snapshots (across every `RfmSegment`), 56 product-daily-view rows.                                                                                  |
| **Newsletter**            | 10 newsletter subscribers (one per registered customer).                                                                                                                                                           |

Money is integer **fils** (1 KWD = 1000 fils) everywhere. `LoyaltyPoints` /
`Return` / `Wishlist` all FK to `User` (role customer), NOT the `Customer` model —
the seed creates the registered `User` rows for that. Run the seed and read the
final `── Every-subsystem enrichment row counts ──` block for the exact per-run
counts.

### Variant shapes demonstrated

| #   | Description                                    | Products | Options | Variants |
| --- | ---------------------------------------------- | -------- | ------- | -------- |
| 1   | Simple (no variants)                           | 15       | —       | —        |
| 2   | 1 option: **Size** (S/M/L)                     | 1        | 1       | 3        |
| 3   | 1 option: **Color** (3 colours)                | 1        | 1       | 3        |
| 4   | 2 options: **Size × Color** (3×3)              | 1        | 2       | 9        |
| 5   | 3 options: **Size × Color × Material** (2×2×2) | 1        | 3       | 8        |

> The platform cap confirmed from `variant.service.ts`: **maximum 3 options per product**.

Edge states included: out-of-stock variants, sale prices (`compareAtPrice`),
`isNew` + `isBestSeller` flags with ordered positions, `featured` products.

## How to Run

### Via Railway (hits production Neon DB)

```bash
railway run npx tsx packages/database/prisma/seed-demo-store.ts
```

### Via npm script

```bash
npm run seed:demo -w @force/database
# or from packages/database/:
npm run seed:demo
```

### Prerequisites

- `DATABASE_URL` + `DIRECT_URL` env vars must point at the target database.
- At least one `super_admin` user must already exist (run the main seed first
  if working on a fresh DB: `npm run db:seed -w @force/database`).

## Idempotency Guarantee

| Data layer                 | Strategy                                                                                          |
| -------------------------- | ------------------------------------------------------------------------------------------------- |
| Store row                  | `upsert` by slug — updates all columns on re-run                                                  |
| Feature flags              | `upsert` per key — idempotent enable                                                              |
| Categories                 | `deleteMany` (this store only) then `createMany`                                                  |
| Products                   | `upsert` by `(storeId, sku)` — stable `DEMO-*` SKU prefix                                         |
| Orders / Reviews / Loyalty | `deleteMany` (this store only) then recreate                                                      |
| Coupons                    | `deleteMany` (this store only) then `createMany`                                                  |
| Blog posts                 | `deleteMany` (this store only) then `createMany`                                                  |
| Store pages                | `deleteMany` (this store only) then `create` per page                                             |
| FAQ entries                | `deleteMany` (this store only) then `createMany`                                                  |
| HowTo entries              | `deleteMany` (this store only) then `create`                                                      |
| Store locations            | `deleteMany` (this store only) then `createMany`; also sets `locationsEnabled: true` on the store |
| layoutSettings             | Overwritten in the `store.update` call at step 12                                                 |

**Other stores are never touched** — every delete is scoped with `where: { storeId: store.id }`.

## Storefront Access

Once seeded, the demo store is accessible at:

```
<platform-domain>/demo
```

No custom domain or DNS change needed — the storefront resolves stores by
path segment.

## Re-running After Schema Changes

If new feature flags are added to `FEATURE_KEYS_ARRAY` in `@force/shared/src/features.ts`,
update the `ALL_FEATURE_KEYS` array at the top of `seed-demo-store.ts` to
match, then re-run the seed.
