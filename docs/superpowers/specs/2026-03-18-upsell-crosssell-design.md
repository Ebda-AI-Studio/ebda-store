# Phase 4: Upsell / Cross-sell / Recommendations — Design Spec

## Overview

Rule-based product recommendation system with 3 recommendation types: Manual Related Products (admin picks), Frequently Bought Together (auto-calculated from order history), and Category Fallback (same category). Displayed on product detail pages and cart page. Toggleable per store via Feature Toggle Engine (`upsell_crosssell`).

## Decisions

- **Approach:** Rule-based (no AI/ML). Admin manual picks + auto co-purchase analysis + category fallback.
- **Placements:** Product detail page + Cart page
- **Recommendation types:** cross_sell (goes well with), upsell (higher-priced alternative), alsoLike (category fallback)
- **Priority:** Manual picks override auto-calculated. Auto overrides category fallback.
- **Co-purchase calculation:** Background job (daily or on-demand), analyzes last 90 days of completed orders.
- **Feature toggle:** `upsell_crosssell` feature key (already registered in Phase 0)

## Data Layer

### New Model: ProductRelation

Admin-managed product-to-product relationships.

```prisma
model ProductRelation {
  id              String   @id @default(uuid())
  storeId         String   @map("store_id")
  sourceProductId String   @map("source_product_id")
  targetProductId String   @map("target_product_id")
  type            String   // 'cross_sell' | 'upsell'
  position        Int      @default(0)
  createdAt       DateTime @default(now()) @map("created_at")

  store         Store   @relation(fields: [storeId], references: [id], onDelete: Cascade)
  sourceProduct Product @relation("ProductRelationSource", fields: [sourceProductId], references: [id], onDelete: Cascade)
  targetProduct Product @relation("ProductRelationTarget", fields: [targetProductId], references: [id], onDelete: Cascade)

  @@unique([storeId, sourceProductId, targetProductId, type])
  @@index([storeId, sourceProductId])
  @@index([storeId, targetProductId])
  @@map("product_relations")
}
```

### New Model: FrequentlyBoughtTogether

Auto-calculated co-purchase data.

```prisma
model FrequentlyBoughtTogether {
  id                String   @id @default(uuid())
  storeId           String   @map("store_id")
  productId1        String   @map("product_id_1")
  productId2        String   @map("product_id_2")
  coOccurrenceCount Int      @default(0) @map("co_occurrence_count")
  lastCalculatedAt  DateTime @default(now()) @map("last_calculated_at")

  store    Store   @relation(fields: [storeId], references: [id], onDelete: Cascade)
  product1 Product @relation("FBTProduct1", fields: [productId1], references: [id], onDelete: Cascade)
  product2 Product @relation("FBTProduct2", fields: [productId2], references: [id], onDelete: Cascade)

  @@unique([storeId, productId1, productId2])
  @@index([storeId, productId1])
  @@index([storeId, productId2])
  @@index([coOccurrenceCount])
  @@map("frequently_bought_together")
}
```

### Relations

Add to Store model:

```prisma
productRelations        ProductRelation[]
frequentlyBoughtTogether FrequentlyBoughtTogether[]
```

Add to Product model:

```prisma
relationsAsSource      ProductRelation[] @relation("ProductRelationSource")
relationsAsTarget      ProductRelation[] @relation("ProductRelationTarget")
fbtAsProduct1          FrequentlyBoughtTogether[] @relation("FBTProduct1")
fbtAsProduct2          FrequentlyBoughtTogether[] @relation("FBTProduct2")
```

## Recommendation Service

### getProductRecommendations(storeId, productId)

Returns `{ crossSell: Product[], upsell: Product[], alsoLike: Product[] }`.

**Priority cascade:**

1. **Cross-sell:** Query `ProductRelation` where sourceProductId = productId AND type = 'cross_sell', ordered by position. Limit 4. If empty → query `FrequentlyBoughtTogether` where productId1 = productId OR productId2 = productId, ordered by coOccurrenceCount DESC. Limit 4.
2. **Upsell:** Query `ProductRelation` where sourceProductId = productId AND type = 'upsell', ordered by position. Limit 4.
3. **Also Like:** Query active products from the same categories as the current product, excluding the current product and any products already in crossSell/upsell. Limit 6.

All queries filter to active products only (`status = 'active'`). Include product images, price, name for display.

### getCartRecommendations(storeId, cartProductIds)

Returns `Product[]` — products that complement the cart contents.

1. For each product in cart, get cross-sell relations (manual first, then auto FBT)
2. Merge all target products, count how many cart items point to each
3. Exclude products already in cart
4. Sort by reference count DESC (most relevant first)
5. Return top 4

### setProductRelations(storeId, productId, relations)

Bulk replace relations for a product:

1. Delete all existing `ProductRelation` where sourceProductId = productId AND storeId
2. Create new relations from input array
3. Each relation: `{ targetProductId, type, position }`

### addProductRelation / removeProductRelation

Single add/remove operations.

## Co-Purchase Calculation Job

### recalculateFBT(storeId)

Analyzes order history to find frequently co-purchased products.

1. Query completed orders from last 90 days with 2+ items
2. For each order, extract product IDs from order items
3. Generate all unique pairs (A,B) — normalize order so productId1 < productId2
4. Count co-occurrences per pair across all orders
5. Upsert into `FrequentlyBoughtTogether` (set coOccurrenceCount, lastCalculatedAt)
6. Delete entries where both products are no longer active
7. Minimum threshold: only store pairs with coOccurrenceCount >= 2 (avoid noise from single orders)

### Scheduling

- Runs daily via `setInterval` in the API server (same pattern as abandoned cart cron)
- Also triggerable on-demand via admin endpoint
- Redis lock to prevent concurrent runs: `fbt:calculating:{storeId}`

## API Endpoints

### Admin Routes

All use: `authenticate → authorize('store_admin', 'super_admin') → requireStoreAccess → requireFeature('upsell_crosssell')`

```
GET    /stores/:storeId/products/:productId/relations      → Get all relations for a product
PUT    /stores/:storeId/products/:productId/relations      → Bulk set relations (replaces all)
POST   /stores/:storeId/products/:productId/relations      → Add single relation
DELETE /stores/:storeId/products/:productId/relations/:id   → Remove relation
POST   /stores/:storeId/recommendations/recalculate         → Trigger FBT recalculation
GET    /stores/:storeId/recommendations/stats               → FBT stats (total pairs, last calculated)
```

### Public Routes

```
GET /public/:storeId/products/:productId/recommendations → { crossSell, upsell, alsoLike }
GET /public/:storeId/cart/recommendations?products=id1,id2,id3 → Product[] for cart
```

No auth required. Results cached in Redis per product (5min TTL), invalidated on relation changes.

## Admin UI

### Product Edit Page — Recommendations Tab

Add a "Recommendations" tab/section on the product edit page (`/stores/[id]/products/[productId]/edit`).

**Cross-sell Section:**

- Title: "Frequently Bought Together"
- Product search input (autocomplete from store's products)
- Selected products shown as cards with drag handles for reordering
- Max 8 products
- Remove button per product

**Upsell Section:**

- Title: "Upsell Alternatives"
- Same search + select pattern
- Max 4 products
- Typically higher-priced products

**Save button** → `PUT /stores/:storeId/products/:productId/relations`

### Settings Page

Add "Recommendations" card in settings (gated by `upsell_crosssell` feature):

- Links to a recommendations overview page or just shows FBT stats
- "Recalculate" button → triggers FBT recalculation
- Shows last calculated timestamp and total product pairs found

## Storefront UI

### Product Detail Page

**"Frequently Bought Together" Section** (below product details, above reviews):

- Shows cross-sell products (manual or auto FBT)
- Each product: image, name, price
- "Add All to Cart" button (adds all cross-sell products + current product)
- Individual "Add to Cart" button per product
- Only shows if cross-sell products exist

**"You Might Also Like" Section** (below "Frequently Bought Together"):

- Shows upsell + alsoLike products in a horizontal scroll/carousel
- Each product: image, name, price, "Add to Cart" button
- Only shows if products exist

Both sections hidden when `upsell_crosssell` feature disabled (via `useFeatures()`).

### Cart Page

**"Complete Your Order" Section** (below cart items, above order summary):

- Shows cart-based recommendations
- Each product: image, name, price, quick "Add" button
- Only shows if recommendations exist and feature is enabled

## Caching

- Product recommendations cached in Redis: `recommendations:product:{storeId}:{productId}` (5min TTL)
- Cart recommendations NOT cached (depends on current cart contents)
- Cache invalidated when:
  - ProductRelation is created/updated/deleted for this product
  - FBT recalculation completes for this store
  - Product is deactivated/deleted

## Error Handling

- Missing recommendations → show empty (no section rendered)
- FBT calculation failure → logged, retried next cycle
- Redis cache failure → fallback to DB query
- Recommendation service errors never block product page or cart page rendering

## Files to Create

| File                                                   | Responsibility                                               |
| ------------------------------------------------------ | ------------------------------------------------------------ |
| `apps/api/src/services/recommendation.service.ts`      | Core: get recommendations, manage relations, FBT calculation |
| `apps/api/src/routes/recommendation.routes.ts`         | Admin + public endpoints                                     |
| `apps/web/src/components/FrequentlyBoughtTogether.tsx` | Product page cross-sell section                              |
| `apps/web/src/components/YouMightAlsoLike.tsx`         | Product page upsell + alsoLike section                       |
| `apps/web/src/components/CartRecommendations.tsx`      | Cart page recommendations                                    |
| `tests/unit/recommendation.test.ts`                    | Unit tests                                                   |

## Files to Modify

| File                                                       | Change                                               |
| ---------------------------------------------------------- | ---------------------------------------------------- |
| `packages/database/prisma/schema.prisma`                   | Add ProductRelation, FrequentlyBoughtTogether models |
| `apps/api/src/routes/index.ts`                             | Mount recommendation routes                          |
| `apps/api/src/index.ts`                                    | Start daily FBT recalculation cron                   |
| `apps/web/src/app/products/[slug]/ProductDetailClient.tsx` | Add cross-sell + alsoLike sections                   |
| `apps/web/src/app/cart/CartClient.tsx`                     | Add cart recommendations section                     |
| `apps/admin/src/app/stores/[id]/products/[productId]/edit` | Add recommendations tab                              |
| `apps/admin/src/app/stores/[id]/settings/page.tsx`         | Add Recommendations settings card                    |
