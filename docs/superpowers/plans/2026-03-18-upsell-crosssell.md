# Upsell / Cross-sell / Recommendations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a rule-based product recommendation system with manual cross-sell/upsell, auto frequently-bought-together from order history, and category fallback — displayed on product pages and cart page.

**Architecture:** ProductRelation model for admin picks, FrequentlyBoughtTogether model for auto-calculated co-purchase data, RecommendationService for query logic with Redis caching, daily FBT cron job, storefront components with feature gating.

**Tech Stack:** Prisma, Express.js, Redis caching, React/Next.js, Feature Toggle Engine

**Spec:** `docs/superpowers/specs/2026-03-18-upsell-crosssell-design.md`

---

## File Structure

**New files:**
| File | Responsibility |
|------|---------------|
| `apps/api/src/services/recommendation.service.ts` | Core: get recommendations, manage relations, FBT calculation |
| `apps/api/src/routes/recommendation.routes.ts` | Admin + public endpoints |
| `apps/web/src/components/FrequentlyBoughtTogether.tsx` | Product page cross-sell section |
| `apps/web/src/components/YouMightAlsoLike.tsx` | Product page upsell + alsoLike carousel |
| `apps/web/src/components/CartRecommendations.tsx` | Cart page recommendations |
| `tests/unit/recommendation.test.ts` | Unit tests |

**Modified files:**
| File | Change |
|------|--------|
| `packages/database/prisma/schema.prisma` | Add ProductRelation, FrequentlyBoughtTogether models |
| `apps/api/src/routes/index.ts` | Mount recommendation routes |
| `apps/api/src/index.ts` | Start daily FBT cron |
| `apps/web/src/app/products/[slug]/ProductDetailClient.tsx` | Add recommendation sections |
| `apps/web/src/app/cart/CartClient.tsx` | Add cart recommendations |
| `apps/admin/src/app/stores/[id]/settings/page.tsx` | Add Recommendations settings card |

---

## Task 1: Prisma Schema — ProductRelation + FrequentlyBoughtTogether

**Files:**

- Modify: `packages/database/prisma/schema.prisma`

- [ ] **Step 1: Add ProductRelation model**

Add after AbandonedCartConfig model:

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

- [ ] **Step 2: Add FrequentlyBoughtTogether model**

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

- [ ] **Step 3: Add relations to Store and Product models**

Store: `productRelations ProductRelation[]`, `frequentlyBoughtTogether FrequentlyBoughtTogether[]`

Product: `relationsAsSource ProductRelation[] @relation("ProductRelationSource")`, `relationsAsTarget ProductRelation[] @relation("ProductRelationTarget")`, `fbtAsProduct1 FrequentlyBoughtTogether[] @relation("FBTProduct1")`, `fbtAsProduct2 FrequentlyBoughtTogether[] @relation("FBTProduct2")`

- [ ] **Step 4: Run prisma generate**

```bash
npm run db:generate
```

- [ ] **Step 5: Commit**

```bash
git commit -m "feat(database): add product relation and frequently bought together models"
```

---

## Task 2: Recommendation Service

**Files:**

- Create: `apps/api/src/services/recommendation.service.ts`

- [ ] **Step 1: Create the service**

Import patterns: `import { prisma } from '@force/database'`, `import { redis } from './redis.service'`, `import { featureService } from './feature.service'`, `import logger from '../lib/logger'`

**Methods:**

`getProductRecommendations(storeId, productId)`:

1. Check Redis cache: `recommendations:product:{storeId}:{productId}` (5min TTL)
2. Cross-sell: query ProductRelation type='cross_sell' by position (limit 4). If empty → query FrequentlyBoughtTogether (limit 4 by coOccurrenceCount DESC)
3. Upsell: query ProductRelation type='upsell' by position (limit 4)
4. AlsoLike: get product's category IDs, query active products from same categories excluding current + crossSell + upsell IDs (limit 6)
5. All queries include product select: id, name, nameAr, slug, price, compareAtPrice, images (first image)
6. Cache and return

`getCartRecommendations(storeId, productIds)`:

1. For each productId, get cross-sell targets (manual then FBT)
2. Merge, count references per target, exclude cart items
3. Sort by count DESC, return top 4
4. NOT cached (depends on cart contents)

`setProductRelations(storeId, productId, relations)`:

1. Delete existing relations for sourceProductId
2. Create new ones with position from array index
3. Invalidate cache for this product

`addRelation(storeId, sourceProductId, targetProductId, type)` / `removeRelation(id, storeId)`

`getRelations(storeId, productId)`: Query all relations for a product, include target product details

`recalculateFBT(storeId)`:

1. Acquire Redis lock `fbt:calculating:{storeId}` (TTL 300s)
2. Query completed orders from last 90 days with 2+ items
3. For each order, get product IDs from order items
4. Generate all pairs, normalize (id1 < id2), count co-occurrences
5. Upsert into FrequentlyBoughtTogether (min threshold: 2)
6. Delete stale entries (inactive products)
7. Invalidate all product recommendation caches for this store
8. Release lock

`startFBTCron(intervalMs = 86400000)` / `stopFBTCron()`: Daily setInterval

Export as `recommendationService` singleton.

**IMPORTANT:** Read the Product model to see what fields to select. Read OrderItem model to see how to get product IDs from orders.

- [ ] **Step 2: Commit**

```bash
git commit -m "feat(api): add recommendation service with manual relations and auto fbt"
```

---

## Task 3: Recommendation API Routes

**Files:**

- Create: `apps/api/src/routes/recommendation.routes.ts`
- Modify: `apps/api/src/routes/index.ts`

- [ ] **Step 1: Create routes**

Follow pattern from existing routes.

Admin routes (authenticate + authorize + requireStoreAccess + requireFeature('upsell_crosssell')):

- `GET /:storeId/products/:productId/relations` → getRelations
- `PUT /:storeId/products/:productId/relations` → setProductRelations (body: array of {targetProductId, type, position})
- `POST /:storeId/products/:productId/relations` → addRelation
- `DELETE /:storeId/products/:productId/relations/:relationId` → removeRelation
- `POST /:storeId/recommendations/recalculate` → recalculateFBT
- `GET /:storeId/recommendations/stats` → FBT stats (total pairs, last calculated)

Public routes:

- `GET /public/:storeId/products/:productId/recommendations` → getProductRecommendations
- `GET /public/:storeId/cart/recommendations?products=id1,id2` → getCartRecommendations

Public routes also check `upsell_crosssell` feature flag before returning results. If disabled → return empty arrays.

- [ ] **Step 2: Mount in index.ts**

```typescript
import recommendationRoutes from './recommendation.routes';
router.use('/stores', recommendationRoutes);
```

Mount public routes under `/public`.

- [ ] **Step 3: Start FBT cron in index.ts**

After abandoned cart cron startup, add:

```typescript
recommendationService.startFBTCron(86400000); // daily
```

Add stop in graceful shutdown.

- [ ] **Step 4: Commit**

```bash
git commit -m "feat(api): add recommendation endpoints and fbt cron"
```

---

## Task 4: Storefront Components

**Files:**

- Create: `apps/web/src/components/FrequentlyBoughtTogether.tsx`
- Create: `apps/web/src/components/YouMightAlsoLike.tsx`
- Create: `apps/web/src/components/CartRecommendations.tsx`
- Modify: `apps/web/src/app/products/[slug]/ProductDetailClient.tsx`
- Modify: `apps/web/src/app/cart/CartClient.tsx`

- [ ] **Step 1: Read existing product detail and cart pages**

Read ProductDetailClient.tsx and CartClient.tsx to understand patterns, styling, how products are displayed, and how useCart/useFeatures hooks are used.

- [ ] **Step 2: Create FrequentlyBoughtTogether component**

`'use client'` component:

- Props: `storeId: string, productId: string`
- Fetches cross-sell from `/api/v1/public/${storeId}/products/${productId}/recommendations`
- Shows product cards with image, name, price
- "Add All to Cart" button (adds all products using useCart().addItem)
- Individual "Add" button per product
- Returns null if no cross-sell products
- Match existing product card styling from ProductGridCard.tsx

- [ ] **Step 3: Create YouMightAlsoLike component**

Similar but shows upsell + alsoLike products in a horizontal scrollable row. Each product is a link to its detail page + "Add to Cart" button.

- [ ] **Step 4: Create CartRecommendations component**

- Props: `storeId: string, productIds: string[]`
- Fetches from `/api/v1/public/${storeId}/cart/recommendations?products=id1,id2`
- Shows up to 4 products with quick "Add" button
- Returns null if no recommendations

- [ ] **Step 5: Add to ProductDetailClient.tsx**

After product details, before reviews section:

```tsx
const { isEnabled } = useFeatures();
{
  isEnabled('upsell_crosssell') && (
    <>
      <FrequentlyBoughtTogether storeId={store.id} productId={product.id} />
      <YouMightAlsoLike storeId={store.id} productId={product.id} />
    </>
  );
}
```

Replace the existing basic "related products" section (category-based) with the new components.

- [ ] **Step 6: Add to CartClient.tsx**

Before order summary section:

```tsx
{
  isEnabled('upsell_crosssell') && cartItems.length > 0 && (
    <CartRecommendations storeId={store.id} productIds={cartItems.map(i => i.productId)} />
  );
}
```

- [ ] **Step 7: Commit**

```bash
git commit -m "feat(web): add product and cart recommendation components"
```

---

## Task 5: Admin UI — Product Recommendations Tab

**Files:**

- Modify: Product edit page (find exact path by reading admin app structure)
- Modify: `apps/admin/src/app/stores/[id]/settings/page.tsx`

- [ ] **Step 1: Find the product edit page**

Search for the product edit page in admin app. It's likely at `apps/admin/src/app/stores/[id]/products/[productId]/edit/page.tsx` or similar.

- [ ] **Step 2: Add recommendations section to product edit**

Add a "Recommendations" section (or tab) with:

- **Cross-sell:** Product search input, selected products with drag-to-reorder, max 8, remove button
- **Upsell:** Same pattern, max 4
- Save → `PUT /stores/:storeId/products/:productId/relations`
- Load existing → `GET /stores/:storeId/products/:productId/relations`

Match existing admin form patterns.

- [ ] **Step 3: Add settings card**

In settings/page.tsx, add:

```typescript
{ title: 'Recommendations', description: 'Product cross-sell, upsell, and auto-suggestions', href: `/stores/${storeId}/products`, icon: /* grid SVG */, color: 'bg-purple-100 text-purple-600', featureKey: 'upsell_crosssell' }
```

- [ ] **Step 4: Commit**

```bash
git commit -m "feat(admin): add product recommendation management ui"
```

---

## Task 6: Unit Tests + Final Verification

**Files:**

- Create: `tests/unit/recommendation.test.ts`

- [ ] **Step 1: Write tests**

1. getProductRecommendations returns correct structure { crossSell, upsell, alsoLike }
2. Cart recommendations excludes products already in cart
3. FBT pair normalization (productId1 < productId2)
4. Relation type validation (only 'cross_sell' and 'upsell')
5. Cache key format is correct

- [ ] **Step 2: Run tests + build**

```bash
npx vitest run tests/unit/recommendation.test.ts
npm run build
```

- [ ] **Step 3: Commit**

```bash
git commit -m "test(api): add unit tests for recommendation service"
```
