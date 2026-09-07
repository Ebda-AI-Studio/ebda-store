# Product Bundles (fixed kits) — Design

**Status:** awaiting Ahmad's review · **Date:** 2026-09-06
**Origin:** a merchant asked to sell "a group of products as an offer, where buying it gives you
more than one item".

## Goal

Let a merchant define a **named kit** — "Ramadan Box: 1 × Dates, 1 × Sidr Honey, 2 × Mixed Nuts,
12.000 KWD" — that a customer buys as **one thing** and receives as **several items**.

Bundle contents are fixed by the merchant. The customer chooses nothing.

## What already exists (checked, not assumed)

- **No bundle/kit/combo concept exists anywhere.** Every `bundle` hit in the codebase is JS
  bundling or layout draft-bundles.
- **`upsell_crosssell` is recommendations only** — "Suggest related or upgraded products". It does
  **not** implement bundles.
  > ⚠️ `docs/business/04-pricing-tiers.md` sells `upsell_crosssell` as "AI-driven product
  > recommendations **+ bundles**". The bundles half does not exist. That line overclaims and
  > should be corrected whether or not this ships.
- **`Promotion` exists and is implemented** (`2026-07-22-promotions-engine-and-coupon-targeting`).
  It is a **cart-level discount**: percentage/fixed, targeted by product/category scope, one
  applied per order. It cannot express "a named catalogue item containing specific products at
  specific quantities", so bundles are a separate entity — but they must not fight it (see
  §Stacking).

## Decisions locked (brainstorm, 2026-09-06)

| Decision         | Chosen                                                 | Rejected, and why                                                                          |
| ---------------- | ------------------------------------------------------ | ------------------------------------------------------------------------------------------ |
| Offer shape      | Fixed kit, contents set by merchant                    | BOGO / pick-any-N / multi-pack — different features; BOGO belongs to the promotions engine |
| Stock            | **Virtual** — draws from component stock               | Own stock count: double-counts the same physical honey                                     |
| Availability     | **Derived**, never stored                              | A stored count drifts; this is a NEVER-stale class value                                   |
| Price            | Type/value pair, mirroring the product discount engine | Single mode — merchants want both a round number and a %                                   |
| Order storage    | **Component lines**, discount allocated                | One bundle line: breaks returns, picking, COGS, backorders                                 |
| Customer display | **One row** — "Ramadan Box · 12.000 KWD"               | Showing per-item allocated prices exposes accounting internals                             |
| Returns          | **Atomic** (whole box only), schema ready for itemized | Itemized now: a second path to test before any merchant asked                              |
| Nested bundles   | **No**                                                 | Makes availability recursive for no merchant benefit                                       |
| WhatsApp bot     | **Yes**, bundles are orderable in DMs                  | Silently absent = a bug someone reports later                                              |

## Data model

```prisma
enum BundlePricingType {
  fixed_price // value = the bundle's price in fils (e.g. 12000)
  percentage  // value = basis points off the component sum (12.5% → 1250), mirrors DiscountType
  fixed       // value = fils off the component sum, mirrors DiscountType
}

model Bundle {
  id            String   @id @default(uuid())
  storeId       String   @map("store_id")
  name          String
  nameAr        String?  @map("name_ar")
  slug          String
  description   String?
  descriptionAr String?  @map("description_ar")
  image         String?
  pricingType   BundlePricingType @map("pricing_type")
  pricingValue  Int               @map("pricing_value")
  isActive      Boolean  @default(true) @map("is_active")
  startsAt      DateTime? @map("starts_at")
  expiresAt     DateTime? @map("expires_at")
  createdAt     DateTime @default(now()) @map("created_at")
  updatedAt     DateTime @updatedAt @map("updated_at")

  store Store        @relation(fields: [storeId], references: [id], onDelete: Cascade)
  items BundleItem[]

  @@unique([storeId, slug])
  @@index([storeId, isActive])
  @@map("bundles")
}

model BundleItem {
  id        String  @id @default(uuid())
  bundleId  String  @map("bundle_id")
  productId String  @map("product_id")
  variantId String? @map("variant_id")
  quantity  Int     // ≥ 1

  bundle  Bundle          @relation(fields: [bundleId], references: [id], onDelete: Cascade)
  product Product         @relation(fields: [productId], references: [id], onDelete: Restrict)
  variant ProductVariant? @relation(fields: [variantId], references: [id], onDelete: Restrict)

  @@unique([bundleId, productId, variantId])
  @@index([bundleId])
  @@index([productId])
  @@map("bundle_items")
}
```

**`onDelete: Restrict` on the product FK is deliberate.** Cascading would silently gut a live
bundle when a merchant deletes one product; restricting forces the merchant to remove the item
from the bundle first. This adds a `NO ACTION`-style child to `products` — the delete handler and
`information_schema.referential_constraints` must be swept per the FK-cascade rule.

### Order columns

```prisma
// OrderItem — groups the lines that came from one bundle purchase
bundleId       String? @map("bundle_id")        // which bundle (nullable = normal line)
bundleGroupId  String? @map("bundle_group_id")  // one uuid per bundle instance in this order
bundleName     String? @map("bundle_name")      // snapshot; survives bundle rename/delete
bundleNameAr   String? @map("bundle_name_ar")

// Order — bundle savings get their own column, matching coupon/promotion/loyalty
bundleDiscount Int @default(0) @map("bundle_discount")
```

`bundleName` is **snapshotted**, not joined. A six-month-old invoice must still say "Ramadan Box"
after the bundle is renamed or deleted — the same reason `productName` and `costPrice` are already
snapshotted on `OrderItem`.

## Pricing and allocation

`bundlePrice` is computed from `pricingType`/`pricingValue` against the components' **current
effective unit prices** (i.e. after each product's own discount), resolved server-side at checkout.

**Invariants — both must hold, and both get tests:**

1. `Σ(line.total)` across a bundle group `== bundlePrice`, exactly, in fils.
2. `line.price × line.quantity == line.total` for every line.

Invariant 2 is why allocation happens on **unit shares**, not line totals: `OrderItem` stores a
unit `price` and a `total`, and a line total that isn't divisible by its quantity cannot be
represented without one of them lying.

**Algorithm** (integer fils throughout — no floats):

1. `weight_i = effectiveUnitPrice_i × quantity_i`
2. `rawShare_i = bundlePrice × weight_i / Σweight` (exact rational)
3. `unit_i = floor(rawShare_i / quantity_i)`; `total_i = unit_i × quantity_i`
4. `residual = bundlePrice − Σtotal_i`
5. Distribute the residual by largest fractional remainder, adding `1` to `unit_i` (which adds
   `quantity_i` to that line) only where `quantity_i ≤ remaining residual`.

**Worked example** — Dates 4.500 ×1, Honey 6.000 ×1, Nuts 2.000 ×2; sum 14.500; box 12.000:

| Line     | weight | raw share | unit            | total       |
| -------- | ------ | --------- | --------------- | ----------- |
| Dates ×1 | 4500   | 3724.13   | 3724            | 3724        |
| Honey ×1 | 6000   | 4965.51   | 4965 → **4966** | 4966        |
| Nuts ×2  | 4000   | 3310.34   | 1655            | 3310        |
|          |        |           |                 | **12000** ✓ |

Residual of 1 fil went to Honey (largest remainder, `.51`, qty 1).

**The unrepresentable edge case, handled at configuration not at checkout.** If every line's
quantity shares a common factor that the residual can't satisfy (e.g. all quantities are 2 and the
residual is 1), no exact split exists. Admin **validates on save** and offers the nearest
allocatable price — "12.000 isn't splittable across these items; use 11.999?" — so the failure
surfaces to the merchant while they are configuring, never to a customer at checkout. With any
qty-1 item in the bundle this can never fire.

## Availability

```
bundleAvailable = min over items of:
    item.product.trackInventory ? floor(availableStock_i / quantity_i) : ∞
```

Derived on read; never written to a column. A bundle is purchasable only while
`bundleAvailable ≥ 1` and it is active and within its date window.

**Oversell prevention:** the component stock check and decrement happen **inside the existing
order-creation transaction**, on the expanded component lines. Because the lines are ordinary
product lines, this reuses the current stock path unchanged rather than adding a second one.

Cached availability is a **NEVER-stale** class value: every write path that changes component
stock must invalidate the bundle's availability — including bulk/admin stock tools, import jobs
and the WhatsApp bot's catalogue cache. A TTL is not sufficient.

## Cart and checkout

- Cart holds `{ bundleId, quantity }` — the bundle, not its parts.
- **Price is recomputed server-side at checkout**, never trusted from the client, exactly as
  existing cart pricing does. A component's price changing between add-to-cart and checkout must
  move the bundle price, and the customer sees the change before paying.
- At order creation the bundle **expands**: for each `BundleItem`, one `OrderItem` with
  `quantity = item.quantity × bundleQty`, tagged with a shared `bundleGroupId`.
- Buying 2 boxes writes **2 groups**, so returning one box is expressible.

## Customer-facing display

Cart, checkout, order confirmation, the emailed invoice and the WhatsApp thread all render the
group as **one row**: name, image, quantity, `bundlePrice`, and optionally "Save 2.500" when the
component sum is higher. Per-item allocated prices are **never shown to a customer** — they are an
accounting artefact.

Admin, picking and returns **do** show the components, because those users need to know what to
physically put in the box.

## Stock, picking, returns

- **Stock** — unchanged. Component lines decrement normally.
- **Picking** — unchanged. The picker sees the real items with real `pickedQty`.
- **Returns — atomic.** The returns screen offers the bundle group as a single selectable unit;
  refund `= Σ` the group's line totals `= bundlePrice`. Restock returns each component's quantity.
  Individual component lines inside a group are **not** independently selectable.
  Enabling itemized returns later is a UI + validation change, not a migration, because the
  allocated share is already stored per line.

## Accounting

Each component line carries its real `costPrice` snapshot and its allocated revenue share, so
per-line profit, the P&L, deadstock and profit-anomaly all keep working with no bundle awareness.
This is the main reason the allocation must exist even though customers never see it.

`Order.bundleDiscount` records `Σ(componentSum − bundlePrice)` for reporting, mirroring how
`couponDiscount` / `promotionDiscount` / `loyaltyDiscount` already work.

## Stacking with coupons and promotions

**Ruling B1 — a bundle's lines are excluded from cart-level `Promotion` scope by default.**
A bundle is already a merchant-authored discount; letting a 20%-off promotion also apply to it
discounts the same items twice and can drive a line below cost. Coupons follow the same rule.
_Cost if wrong:_ a store sells boxes under cost during a campaign and nobody notices until the
P&L. Revisit only with an explicit merchant opt-in flag.

## Feature gating

New feature key **`bundles`**, `tier: 'addon'` — sold and enabled independently, not folded into
`upsell_crosssell`. Gated per store via `StoreFeature` like every other addon.

## Testing (the five layers)

- **Unit** — allocation: sums exactly to `bundlePrice`; `price × qty == total` on every line;
  largest-remainder determinism; the unrepresentable-price validator; availability `min(floor())`
  including a `trackInventory: false` component.
- **Integration** — order creation expands correctly; stock decrements components; concurrent
  checkout of the last box oversells nothing; atomic return refunds exactly `bundlePrice` and
  restocks every component.
- **E2E** — add box → checkout → paid → order shows ONE row to the customer and components in
  admin.
- **Load** — bundle availability on a category page must not become an N+1 across components.
- **UAT** — a merchant builds a bundle, sees the availability it derives, and sells one.

**Mutation-test the money invariants**, per the standing rule: break the allocation so it sums to
`bundlePrice ± 1` and name the test that reddens. A green suite that never fails on a wrong total
is not evidence.

## Blast-radius surfaces to sweep at PR time

Every consumer of `OrderItem` (returns, backorders, picking, COGS, XLSX export, analytics);
product delete + cascade handlers and `information_schema.referential_constraints` for the new
`Restrict` FK; catalogue/search/sitemap; the **AI product feed** (`/feeds/products.json`); the
WhatsApp bot catalogue cache and its intent classifier; abandoned-cart (a cart holding a bundle);
`plan-feature-matrix.md` and `02-feature-catalog.md`; and the `04-pricing-tiers.md` overclaim.

## Out of scope (YAGNI)

BOGO and spend-more-save-more (that is the promotions engine); customer-chosen "any 3 for 10";
nested bundles; per-bundle stock; itemized returns; bundle-specific shipping rules.

## Open rulings for Ahmad

1. **B1 stacking** — confirm bundles are excluded from coupons and promotions.
2. **Pricing-doc correction** — fix the `upsell_crosssell` "+ bundles" claim now, or when this ships?
3. **Bundle page** — does a bundle get its own storefront URL (`/bundles/<slug>`, indexable), or
   does it only appear as a card in listings? A URL means sitemap, OG image and AEO surfaces.
