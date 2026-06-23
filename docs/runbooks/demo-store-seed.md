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
