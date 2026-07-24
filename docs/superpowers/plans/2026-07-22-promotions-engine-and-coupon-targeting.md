# Promotions Engine + Coupon Targeting Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a shared targeting model + evaluator that gives the existing code-based coupons the targeting they lack and introduces automatic (code-less) promotions, both applied server-side at checkout.

**Architecture:** Parallel structure — keep `Coupon` intact, add a `Promotion` model, and share a pure evaluator (`promotion-targeting.ts`) plus a common targeting field set. Discounts remain server-authoritative in `order.service.ts`; coupon vs best auto-promotion resolve best-of (never additive); loyalty stacks on the remainder unchanged.

**Tech Stack:** Express + TypeScript API, Prisma + Neon (Postgres, RLS), Next.js 16 admin/web, Vitest, Zod, next-intl.

## Global Constraints

- Money is stored in **fils** (integer; 1 KWD = 1000 fils). Discounts never exceed the matching subtotal; `total = max(0, subtotal + tax + shipping − discount)`.
- Discounts are **server-computed only** — never trust a client-asserted discount.
- Every admin route: `authenticate → authorize('store_admin','super_admin') → requireStoreAccess`.
- New tenant table gets **FORCE ROW LEVEL SECURITY** + one policy **per command**; predicate `current_store_id() IS NULL OR current_setting('app.bypass_rls', true) = 'true' OR store_id = current_store_id()`. Bypass value is `'true'`, never `'on'`.
- commitlint: lowercase subject; scope ∈ api/web/admin/database/ui/shared/config/auth/store/product/order/cart/deps/ci.
- Verify exit codes directly (`cmd; echo $?`). Fresh worktree already has deps; after schema edits run `npm run db:generate` then `npm run build -w packages/database`.
- Discount types reuse the existing `CouponType` enum: `percentage | fixed | free_shipping`.
- "Every data has a UI": the `promotions` table must ship with an admin page in the same PR.

---

### Task 1: Schema — Promotion model, coupon targeting fields, order audit columns

**Files:**

- Modify: `packages/database/prisma/schema.prisma` (Coupon model, new Promotion model, Order model, Store relation, CustomerGroup relation)
- Create: `packages/database/prisma/migrations/20260722140000_promotions_and_coupon_targeting/migration.sql`

**Interfaces:**

- Produces: Prisma models `Promotion`, extended `Coupon` (targeting fields), `Order.promotionDiscount`/`Order.appliedPromotionId`. Field names below are consumed by every later task.

- [ ] **Step 1: Add the shared targeting fields to `Coupon`**

In `model Coupon`, after `usageLimitPerUser`, add:

```prisma
  // Targeting (shared shape with Promotion). All optional/empty = "everyone,
  // whole cart" so existing coupons are unchanged.
  customerGroupId   String?    @map("customer_group_id")
  firstOrderOnly    Boolean    @default(false) @map("first_order_only")
  minQuantity       Int?       @map("min_quantity")
  scopeProductIds   String[]   @map("scope_product_ids")
  scopeCategoryIds  String[]   @map("scope_category_ids")
```

And in the Coupon relations block add:

```prisma
  customerGroup  CustomerGroup? @relation(fields: [customerGroupId], references: [id], onDelete: SetNull)
```

And add an index near the other `@@index` lines:

```prisma
  @@index([storeId, customerGroupId])
```

- [ ] **Step 2: Add the `Promotion` model** (place it right after `model Coupon { … }`)

```prisma
/// Automatic, code-less discount applied when its targeting matches the cart +
/// customer. Shares the targeting field set with Coupon; the difference is
/// coupons need a code, promotions apply automatically. Types reuse CouponType.
model Promotion {
  id               String     @id @default(uuid())
  storeId          String     @map("store_id")
  name             String
  nameAr           String?    @map("name_ar")
  description      String?
  descriptionAr    String?    @map("description_ar")
  type             CouponType @default(percentage)
  value            Int // percentage (0-100) or fixed amount in fils
  maxDiscount      Int?       @map("max_discount")
  priority         Int        @default(0) // higher wins when several are eligible
  isActive         Boolean    @default(true) @map("is_active")
  startsAt         DateTime?  @map("starts_at")
  expiresAt        DateTime?  @map("expires_at")

  // Targeting (shared shape with Coupon)
  customerGroupId  String?    @map("customer_group_id")
  firstOrderOnly   Boolean    @default(false) @map("first_order_only")
  minOrderAmount   Int?       @map("min_order_amount")
  minQuantity      Int?       @map("min_quantity")
  scopeProductIds  String[]   @map("scope_product_ids")
  scopeCategoryIds String[]   @map("scope_category_ids")

  createdAt        DateTime   @default(now()) @map("created_at")
  updatedAt        DateTime   @updatedAt @map("updated_at")

  store          Store          @relation(fields: [storeId], references: [id], onDelete: Cascade)
  customerGroup  CustomerGroup? @relation(fields: [customerGroupId], references: [id], onDelete: SetNull)
  orders         Order[]        @relation("OrderAppliedPromotion")

  @@index([storeId, isActive])
  @@index([storeId, customerGroupId])
  @@map("promotions")
}
```

- [ ] **Step 3: Add order audit columns + relations, and back-relations**

In `model Order`, near `couponDiscount`, add:

```prisma
  promotionDiscount     Int                @default(0) @map("promotion_discount")
  appliedPromotionId    String?            @map("applied_promotion_id")
```

In the Order relations block add:

```prisma
  appliedPromotion    Promotion?           @relation("OrderAppliedPromotion", fields: [appliedPromotionId], references: [id], onDelete: SetNull)
```

In `model Store` relations add `promotions Promotion[]`. In `model CustomerGroup` relations add `coupons Coupon[]` and `promotions Promotion[]`.

- [ ] **Step 4: Write the migration SQL**

Create `packages/database/prisma/migrations/20260722140000_promotions_and_coupon_targeting/migration.sql`:

```sql
-- Promotions engine + coupon targeting.
--
-- Adds a shared targeting field set to coupons and a new `promotions` table
-- (automatic, code-less discounts), plus order audit columns for the applied
-- promotion. All coupon targeting columns are nullable / default-empty, so
-- existing coupons keep targeting everyone. RLS: promotions is tenant data —
-- FORCE RLS + one policy per command, canonical hybrid predicate copied from
-- 20260609000000. Bypass value is 'true', never 'on'.

-- ── coupons: targeting columns ────────────────────────────────────────────────
ALTER TABLE "coupons"
  ADD COLUMN "customer_group_id"  TEXT,
  ADD COLUMN "first_order_only"   BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "min_quantity"       INTEGER,
  ADD COLUMN "scope_product_ids"  TEXT[] NOT NULL DEFAULT '{}',
  ADD COLUMN "scope_category_ids" TEXT[] NOT NULL DEFAULT '{}';

ALTER TABLE "coupons"
  ADD CONSTRAINT "coupons_customer_group_id_fkey"
  FOREIGN KEY ("customer_group_id") REFERENCES "customer_groups"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "coupons_store_id_customer_group_id_idx"
  ON "coupons" ("store_id", "customer_group_id");

-- ── promotions ────────────────────────────────────────────────────────────────
CREATE TABLE "promotions" (
  "id"                 TEXT         NOT NULL,
  "store_id"           TEXT         NOT NULL,
  "name"               TEXT         NOT NULL,
  "name_ar"            TEXT,
  "description"        TEXT,
  "description_ar"     TEXT,
  "type"               "CouponType" NOT NULL DEFAULT 'percentage',
  "value"              INTEGER      NOT NULL,
  "max_discount"       INTEGER,
  "priority"           INTEGER      NOT NULL DEFAULT 0,
  "is_active"          BOOLEAN      NOT NULL DEFAULT true,
  "starts_at"          TIMESTAMP(3),
  "expires_at"         TIMESTAMP(3),
  "customer_group_id"  TEXT,
  "first_order_only"   BOOLEAN      NOT NULL DEFAULT false,
  "min_order_amount"   INTEGER,
  "min_quantity"       INTEGER,
  "scope_product_ids"  TEXT[]       NOT NULL DEFAULT '{}',
  "scope_category_ids" TEXT[]       NOT NULL DEFAULT '{}',
  "created_at"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"         TIMESTAMP(3) NOT NULL,
  CONSTRAINT "promotions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "promotions_store_id_fkey"
    FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "promotions_customer_group_id_fkey"
    FOREIGN KEY ("customer_group_id") REFERENCES "customer_groups"("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE INDEX "promotions_store_id_is_active_idx" ON "promotions" ("store_id", "is_active");
CREATE INDEX "promotions_store_id_customer_group_id_idx" ON "promotions" ("store_id", "customer_group_id");

-- ── orders: applied-promotion audit ───────────────────────────────────────────
ALTER TABLE "orders"
  ADD COLUMN "promotion_discount"  INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "applied_promotion_id" TEXT;

ALTER TABLE "orders"
  ADD CONSTRAINT "orders_applied_promotion_id_fkey"
  FOREIGN KEY ("applied_promotion_id") REFERENCES "promotions"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- ── RLS ───────────────────────────────────────────────────────────────────────
ALTER TABLE "promotions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "promotions" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "promotions_app_select" ON "promotions";
CREATE POLICY "promotions_app_select" ON "promotions" FOR SELECT
  USING (current_store_id() IS NULL OR current_setting('app.bypass_rls', true) = 'true' OR store_id = current_store_id());

DROP POLICY IF EXISTS "promotions_app_insert" ON "promotions";
CREATE POLICY "promotions_app_insert" ON "promotions" FOR INSERT
  WITH CHECK (current_store_id() IS NULL OR current_setting('app.bypass_rls', true) = 'true' OR store_id = current_store_id());

DROP POLICY IF EXISTS "promotions_app_update" ON "promotions";
CREATE POLICY "promotions_app_update" ON "promotions" FOR UPDATE
  USING (current_store_id() IS NULL OR current_setting('app.bypass_rls', true) = 'true' OR store_id = current_store_id())
  WITH CHECK (current_store_id() IS NULL OR current_setting('app.bypass_rls', true) = 'true' OR store_id = current_store_id());

DROP POLICY IF EXISTS "promotions_app_delete" ON "promotions";
CREATE POLICY "promotions_app_delete" ON "promotions" FOR DELETE
  USING (current_store_id() IS NULL OR current_setting('app.bypass_rls', true) = 'true' OR store_id = current_store_id());
```

- [ ] **Step 5: Validate + generate + build**

Run: `npx prisma validate --schema packages/database/prisma/schema.prisma; echo $?`
Then: `npm run db:generate; echo $?` and `npm run build -w packages/database; echo $?`
Expected: generate + build exit 0. (The `validate` "getConfig" env warning from a bare `--schema` path is not a schema error; `db:generate` succeeding is the real signal.)

- [ ] **Step 6: Commit**

```bash
git add packages/database/prisma/schema.prisma packages/database/prisma/migrations/20260722140000_promotions_and_coupon_targeting/migration.sql
git commit -m "feat(database): promotions table + coupon targeting fields + order audit columns"
```

---

### Task 2: Shared targeting evaluator (pure, TDD)

**Files:**

- Create: `apps/api/src/services/promotion-targeting.ts`
- Test: `tests/unit/promotion-targeting.test.ts`

**Interfaces:**

- Produces:
  - `interface TargetingCtx { customerGroupId: string | null; isFirstOrder: boolean; cartItems: CartItemForTargeting[] }`
  - `interface CartItemForTargeting { productId: string; categoryIds: string[]; quantity: number; lineTotal: number }`
  - `interface Targeting { customerGroupId: string | null; firstOrderOnly: boolean; minOrderAmount: number | null; minQuantity: number | null; scopeProductIds: string[]; scopeCategoryIds: string[] }`
  - `matchesTargeting(t: Targeting, ctx: TargetingCtx): { eligible: boolean; matchingSubtotal: number; matchingQty: number }`
  - `computeDiscount(type: 'percentage'|'fixed'|'free_shipping', value: number, maxDiscount: number | null, base: number): number`

- [ ] **Step 1: Write failing tests**

Create `tests/unit/promotion-targeting.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { matchesTargeting, computeDiscount } from '../../apps/api/src/services/promotion-targeting';

const item = (
  o: Partial<{ productId: string; categoryIds: string[]; quantity: number; lineTotal: number }> = {}
) => ({
  productId: o.productId ?? 'p1',
  categoryIds: o.categoryIds ?? ['c1'],
  quantity: o.quantity ?? 1,
  lineTotal: o.lineTotal ?? 1000,
});
const base = {
  customerGroupId: null,
  firstOrderOnly: false,
  minOrderAmount: null,
  minQuantity: null,
  scopeProductIds: [],
  scopeCategoryIds: [],
};
const ctx = (
  o: Partial<{
    customerGroupId: string | null;
    isFirstOrder: boolean;
    cartItems: ReturnType<typeof item>[];
  }> = {}
) => ({
  customerGroupId: o.customerGroupId ?? null,
  isFirstOrder: o.isFirstOrder ?? false,
  cartItems: o.cartItems ?? [item()],
});

describe('matchesTargeting', () => {
  it('matches everyone / whole cart when untargeted', () => {
    const r = matchesTargeting(
      base,
      ctx({ cartItems: [item({ lineTotal: 1000 }), item({ productId: 'p2', lineTotal: 500 })] })
    );
    expect(r).toEqual({ eligible: true, matchingSubtotal: 1500, matchingQty: 2 });
  });
  it('requires the customer to be in the targeted group', () => {
    expect(
      matchesTargeting({ ...base, customerGroupId: 'g1' }, ctx({ customerGroupId: 'g1' })).eligible
    ).toBe(true);
    expect(
      matchesTargeting({ ...base, customerGroupId: 'g1' }, ctx({ customerGroupId: 'g2' })).eligible
    ).toBe(false);
    expect(
      matchesTargeting({ ...base, customerGroupId: 'g1' }, ctx({ customerGroupId: null })).eligible
    ).toBe(false);
  });
  it('enforces first-order-only', () => {
    expect(
      matchesTargeting({ ...base, firstOrderOnly: true }, ctx({ isFirstOrder: true })).eligible
    ).toBe(true);
    expect(
      matchesTargeting({ ...base, firstOrderOnly: true }, ctx({ isFirstOrder: false })).eligible
    ).toBe(false);
  });
  it('scopes the subtotal to matching products only', () => {
    const r = matchesTargeting(
      { ...base, scopeProductIds: ['p1'] },
      ctx({
        cartItems: [
          item({ productId: 'p1', lineTotal: 1000 }),
          item({ productId: 'p2', lineTotal: 500 }),
        ],
      })
    );
    expect(r).toEqual({ eligible: true, matchingSubtotal: 1000, matchingQty: 1 });
  });
  it('scopes by category', () => {
    const r = matchesTargeting(
      { ...base, scopeCategoryIds: ['c2'] },
      ctx({
        cartItems: [
          item({ categoryIds: ['c1'], lineTotal: 1000 }),
          item({ productId: 'p2', categoryIds: ['c2'], lineTotal: 700 }),
        ],
      })
    );
    expect(r).toEqual({ eligible: true, matchingSubtotal: 700, matchingQty: 1 });
  });
  it('is ineligible when a scope matches nothing', () => {
    expect(matchesTargeting({ ...base, scopeProductIds: ['pX'] }, ctx()).eligible).toBe(false);
  });
  it('gates on min order amount (matching subtotal) and min quantity', () => {
    expect(
      matchesTargeting(
        { ...base, minOrderAmount: 2000 },
        ctx({ cartItems: [item({ lineTotal: 1500 })] })
      ).eligible
    ).toBe(false);
    expect(
      matchesTargeting({ ...base, minQuantity: 3 }, ctx({ cartItems: [item({ quantity: 2 })] }))
        .eligible
    ).toBe(false);
    expect(
      matchesTargeting({ ...base, minQuantity: 3 }, ctx({ cartItems: [item({ quantity: 3 })] }))
        .eligible
    ).toBe(true);
  });
});

describe('computeDiscount', () => {
  it('percentage, capped by maxDiscount', () => {
    expect(computeDiscount('percentage', 10, null, 1000)).toBe(100);
    expect(computeDiscount('percentage', 50, 200, 1000)).toBe(200);
  });
  it('fixed, clamped to base', () => {
    expect(computeDiscount('fixed', 300, null, 1000)).toBe(300);
    expect(computeDiscount('fixed', 5000, null, 1000)).toBe(1000);
  });
  it('free_shipping yields no line discount', () => {
    expect(computeDiscount('free_shipping', 0, null, 1000)).toBe(0);
  });
});
```

- [ ] **Step 2: Run to verify failure**
      Run: `npx vitest run tests/unit/promotion-targeting.test.ts; echo $?`
      Expected: FAIL (module not found).

- [ ] **Step 3: Implement the evaluator**

Create `apps/api/src/services/promotion-targeting.ts`:

```ts
/**
 * Pure targeting/discount math shared by coupons (code-based) and promotions
 * (automatic). No DB access — callers pass a fully-resolved context so this
 * stays trivially testable and safe to run in the order transaction.
 */
export interface CartItemForTargeting {
  productId: string;
  categoryIds: string[];
  quantity: number;
  lineTotal: number; // fils
}

export interface TargetingCtx {
  customerGroupId: string | null;
  isFirstOrder: boolean;
  cartItems: CartItemForTargeting[];
}

export interface Targeting {
  customerGroupId: string | null;
  firstOrderOnly: boolean;
  minOrderAmount: number | null;
  minQuantity: number | null;
  scopeProductIds: string[];
  scopeCategoryIds: string[];
}

export interface TargetingResult {
  eligible: boolean;
  matchingSubtotal: number;
  matchingQty: number;
}

function itemInScope(item: CartItemForTargeting, t: Targeting): boolean {
  // Union: in scope if it matches the product scope OR the category scope. Only
  // called when at least one facet is set (see the `scoped` guard below), so a
  // single-facet scope reduces to that one facet. (Decided 2026-07-22.)
  const productMatch = t.scopeProductIds.includes(item.productId);
  const categoryMatch = item.categoryIds.some(c => t.scopeCategoryIds.includes(c));
  return productMatch || categoryMatch;
}

export function matchesTargeting(t: Targeting, ctx: TargetingCtx): TargetingResult {
  const miss: TargetingResult = { eligible: false, matchingSubtotal: 0, matchingQty: 0 };

  if (t.customerGroupId && t.customerGroupId !== ctx.customerGroupId) return miss;
  if (t.firstOrderOnly && !ctx.isFirstOrder) return miss;

  const scoped = t.scopeProductIds.length > 0 || t.scopeCategoryIds.length > 0;
  const matching = scoped ? ctx.cartItems.filter(i => itemInScope(i, t)) : ctx.cartItems;

  const matchingSubtotal = matching.reduce((s, i) => s + i.lineTotal, 0);
  const matchingQty = matching.reduce((s, i) => s + i.quantity, 0);

  if (scoped && matchingSubtotal <= 0) return miss;
  if (t.minOrderAmount != null && matchingSubtotal < t.minOrderAmount) return miss;
  if (t.minQuantity != null && matchingQty < t.minQuantity) return miss;

  return { eligible: true, matchingSubtotal, matchingQty };
}

export function computeDiscount(
  type: 'percentage' | 'fixed' | 'free_shipping',
  value: number,
  maxDiscount: number | null,
  base: number
): number {
  if (type === 'percentage') {
    const d = Math.round((base * value) / 100);
    return maxDiscount != null && d > maxDiscount ? maxDiscount : d;
  }
  if (type === 'fixed') {
    return value > base ? base : value;
  }
  return 0; // free_shipping is handled on the shipping line, not here
}
```

- [ ] **Step 4: Run to verify pass**
      Run: `npx vitest run tests/unit/promotion-targeting.test.ts; echo $?`
      Expected: PASS, exit 0.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/promotion-targeting.ts tests/unit/promotion-targeting.test.ts
git commit -m "feat(api): shared promotion/coupon targeting evaluator"
```

---

### Task 3: Promotion CRUD service + route + admin mount

**Files:**

- Create: `apps/api/src/services/promotion.service.ts`
- Create: `apps/api/src/routes/promotion.routes.ts`
- Modify: `apps/api/src/routes/index.ts` (mount)
- Test: `tests/unit/promotion.service.test.ts`

**Interfaces:**

- Consumes: Prisma `Promotion` (Task 1).
- Produces: `PromotionService.{list,getById,create,update,delete,toggleActive}` and `GET/POST/PUT/DELETE /stores/:storeId/promotions`.

- [ ] **Step 1: Write failing service tests**

Create `tests/unit/promotion.service.test.ts` mirroring the mock style of `tests/unit/customer-group.service.test.ts` (hoisted `mockPromotion` with `findMany/findFirst/create/update/delete/count`, `vi.mock('@force/database')`). Assert:

```ts
// create: rejects value>100 for percentage type
await expect(
  PromotionService.create(STORE, { name: 'x', type: 'percentage', value: 150 })
).rejects.toMatchObject({ statusCode: 400 });
// getById: 404 cross-tenant
mockPromotion.findFirst.mockResolvedValue(null);
await expect(PromotionService.getById(STORE, 'nope')).rejects.toMatchObject({ statusCode: 404 });
// update: 404 cross-tenant before write
mockPromotion.findFirst.mockResolvedValue(null);
await expect(PromotionService.update(STORE, 'nope', { name: 'y' })).rejects.toMatchObject({
  statusCode: 404,
});
```

- [ ] **Step 2: Run to verify failure**
      Run: `npx vitest run tests/unit/promotion.service.test.ts; echo $?` → FAIL.

- [ ] **Step 3: Implement `PromotionService`**

Create `apps/api/src/services/promotion.service.ts`. Structure mirrors `apps/api/src/services/coupon.service.ts` (list with pagination + search, getById 404, create/update/delete, toggleActive) minus code/usage logic, plus the targeting fields. Key validation to include:

```ts
// In create/update, before writing:
if (data.type === 'percentage' && (data.value < 0 || data.value > 100)) {
  throw new AppError(400, 'INVALID_VALUE', 'Percentage promotions must be 0-100.');
}
if (data.type === 'fixed' && data.value < 0) {
  throw new AppError(400, 'INVALID_VALUE', 'Fixed discount cannot be negative.');
}
```

Persist all fields from Task 1's model. `list` orders by `[{ priority: 'desc' }, { createdAt: 'desc' }]`. `create` data includes `scopeProductIds: data.scopeProductIds ?? []`, `scopeCategoryIds: data.scopeCategoryIds ?? []`.

- [ ] **Step 4: Implement the route**

Create `apps/api/src/routes/promotion.routes.ts` mirroring `apps/api/src/routes/coupon.routes.ts` route shape (`authenticate → authorize('store_admin','super_admin') → requireStoreAccess`, `router.param('storeId', tenantContext)` per `customer-groups.routes.ts`). Zod `createSchema`:

```ts
const createSchema = z.object({
  name: z.string().min(1).max(150),
  nameAr: z.string().max(150).nullish(),
  description: z.string().max(2000).nullish(),
  descriptionAr: z.string().max(2000).nullish(),
  type: z.enum(['percentage', 'fixed', 'free_shipping']),
  value: z.number().int().min(0),
  maxDiscount: z.number().int().min(0).nullish(),
  priority: z.number().int().min(0).max(1000).optional(),
  isActive: z.boolean().optional(),
  startsAt: z.coerce.date().nullish(),
  expiresAt: z.coerce.date().nullish(),
  customerGroupId: z.string().uuid().nullish(),
  firstOrderOnly: z.boolean().optional(),
  minOrderAmount: z.number().int().min(0).nullish(),
  minQuantity: z.number().int().min(1).nullish(),
  scopeProductIds: z.array(z.string().uuid()).max(500).optional(),
  scopeCategoryIds: z.array(z.string().uuid()).max(200).optional(),
});
const updateSchema = createSchema.partial();
```

Routes: `GET /:storeId/promotions`, `GET /:storeId/promotions/:id`, `POST`, `PUT /:id`, `DELETE /:id`, `PATCH /:id/toggle`.

- [ ] **Step 5: Mount the route**

In `apps/api/src/routes/index.ts`, import `promotionRoutes from './promotion.routes'` and add next to the customer-groups mount:

```ts
router.use('/stores', tenantContext, promotionRoutes);
```

- [ ] **Step 6: Run tests + typecheck**
      Run: `npx vitest run tests/unit/promotion.service.test.ts; echo $?` → PASS.
      Run: `npx tsc --noEmit -p apps/api/tsconfig.json; echo $?` → 0.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/services/promotion.service.ts apps/api/src/routes/promotion.routes.ts apps/api/src/routes/index.ts tests/unit/promotion.service.test.ts
git commit -m "feat(api): promotion crud service and routes"
```

---

### Task 4: Coupon targeting — persist + evaluate

**Files:**

- Modify: `apps/api/src/services/coupon.service.ts` (persist targeting; add `evaluateForCart`)
- Modify: `apps/api/src/routes/coupon.routes.ts` (create/update schema; `/validate` runs targeting)
- Test: `tests/unit/coupon.service.test.ts` (create if absent)

**Interfaces:**

- Consumes: `matchesTargeting`, `computeDiscount` (Task 2); Prisma `Coupon` targeting fields (Task 1).
- Produces: `CouponService.evaluateForCart(coupon, ctx): { eligible: boolean; discount: number; reason?: string }`.

- [ ] **Step 1: Write failing test for `evaluateForCart`**

```ts
// A coupon targeting group g1 is ineligible for a g2 customer.
const coupon = {
  type: 'percentage',
  value: 10,
  maxDiscount: null,
  customerGroupId: 'g1',
  firstOrderOnly: false,
  minOrderAmount: null,
  minQuantity: null,
  scopeProductIds: [],
  scopeCategoryIds: [],
};
expect(
  CouponService.evaluateForCart(coupon as any, {
    customerGroupId: 'g2',
    isFirstOrder: false,
    cartItems: [{ productId: 'p1', categoryIds: [], quantity: 1, lineTotal: 1000 }],
  })
).toMatchObject({ eligible: false });
// Eligible + discount on matching subtotal.
expect(
  CouponService.evaluateForCart({ ...coupon, customerGroupId: null } as any, {
    customerGroupId: null,
    isFirstOrder: false,
    cartItems: [{ productId: 'p1', categoryIds: [], quantity: 1, lineTotal: 1000 }],
  })
).toMatchObject({ eligible: true, discount: 100 });
```

- [ ] **Step 2: Run → FAIL.**
      Run: `npx vitest run tests/unit/coupon.service.test.ts; echo $?`

- [ ] **Step 3: Add `evaluateForCart` + targeting persistence**

In `coupon.service.ts`, add the fields to `CreateCouponData` (customerGroupId?, firstOrderOnly?, minQuantity?, scopeProductIds?, scopeCategoryIds?) and to the `create`/`update` `data` blocks (`scopeProductIds: data.scopeProductIds ?? []`, etc.). Add:

```ts
import { matchesTargeting, computeDiscount, TargetingCtx } from './promotion-targeting';

static evaluateForCart(
  coupon: {
    type: 'percentage' | 'fixed' | 'free_shipping'; value: number; maxDiscount: number | null;
    customerGroupId: string | null; firstOrderOnly: boolean; minOrderAmount: number | null;
    minQuantity: number | null; scopeProductIds: string[]; scopeCategoryIds: string[];
  },
  ctx: TargetingCtx
): { eligible: boolean; discount: number; reason?: string } {
  const r = matchesTargeting(coupon, ctx);
  if (!r.eligible) return { eligible: false, discount: 0, reason: 'COUPON_NOT_ELIGIBLE' };
  const discount = computeDiscount(coupon.type, coupon.value, coupon.maxDiscount, r.matchingSubtotal);
  return { eligible: true, discount };
}
```

- [ ] **Step 4: `/validate` runs targeting**

In `coupon.routes.ts` `/validate` handler, accept an optional `cartItems` + identity in the body; when present, resolve the customer's group (via the identity bridge — see Task 5's `resolveCustomerContext`) and call `evaluateForCart`, returning `{ eligible, discount }` or a 400 with the reason. When absent, preserve today's behavior.

- [ ] **Step 5: Run tests + typecheck → PASS / 0.**

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/services/coupon.service.ts apps/api/src/routes/coupon.routes.ts tests/unit/coupon.service.test.ts
git commit -m "feat(api): add targeting to coupons"
```

---

### Task 5: Checkout wiring — customer context, promotion resolution, best-of

**Files:**

- Create: `apps/api/src/services/promotion-resolver.ts` (DB-facing orchestration)
- Modify: `apps/api/src/services/order.service.ts` (discount block ~410-475 + persist columns ~670)
- Test: `tests/unit/promotion-resolver.test.ts`

**Interfaces:**

- Consumes: `PromotionService`/Prisma, `matchesTargeting`, `computeDiscount`, `CouponService.evaluateForCart`.
- Produces:
  - `resolveCustomerContext(storeId, { phone, email, customerId }): Promise<{ customerGroupId: string | null; isFirstOrder: boolean }>`
  - `resolveBestPromotion(storeId, ctx: TargetingCtx): Promise<{ promotionId: string; discount: number } | null>`

- [ ] **Step 1: Write failing tests for `resolveBestPromotion`** (mock prisma.promotion.findMany returning 2 active promos; assert the higher-priority eligible one wins; ineligible ones filtered; ties broken by larger discount). Mock style as in `promotion.service.test.ts`.

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Implement `promotion-resolver.ts`**

```ts
import { prisma } from '@force/database';
import { matchesTargeting, computeDiscount, TargetingCtx } from './promotion-targeting';

export async function resolveCustomerContext(
  storeId: string,
  id: { phone?: string | null; email?: string | null }
): Promise<{ customerGroupId: string | null; isFirstOrder: boolean }> {
  const or = [] as { phone?: string; email?: { equals: string; mode: 'insensitive' } }[];
  if (id.phone) or.push({ phone: id.phone });
  if (id.email) or.push({ email: { equals: id.email, mode: 'insensitive' } });
  if (or.length === 0) return { customerGroupId: null, isFirstOrder: true };
  const customer = await prisma.customer.findFirst({
    where: { storeId, OR: or },
    select: { groupId: true },
  });
  // First-order = no prior non-cancelled order for this identity. Reuse the
  // order-aggregation identity match already used by the customers detail route.
  const priorCount = await prisma.order.count({
    where: {
      storeId,
      deletedAt: null,
      status: { not: 'cancelled' },
      OR: [
        ...(id.phone ? [{ shippingAddress: { path: ['phone'], equals: id.phone } }] : []),
        ...(id.email ? [{ shippingAddress: { path: ['email'], equals: id.email } }] : []),
      ],
    },
  });
  return { customerGroupId: customer?.groupId ?? null, isFirstOrder: priorCount === 0 };
}

export async function resolveBestPromotion(
  storeId: string,
  ctx: TargetingCtx
): Promise<{ promotionId: string; discount: number } | null> {
  const now = new Date();
  const promos = await prisma.promotion.findMany({
    where: {
      storeId,
      isActive: true,
      type: { not: 'free_shipping' },
      AND: [
        { OR: [{ startsAt: null }, { startsAt: { lte: now } }] },
        { OR: [{ expiresAt: null }, { expiresAt: { gte: now } }] },
      ],
    },
    orderBy: [{ priority: 'desc' }, { createdAt: 'desc' }],
  });
  let best: { promotionId: string; discount: number } | null = null;
  for (const p of promos) {
    const r = matchesTargeting(p, ctx);
    if (!r.eligible) continue;
    const discount = computeDiscount(p.type, p.value, p.maxDiscount, r.matchingSubtotal);
    if (discount <= 0) continue;
    if (!best || discount > best.discount) best = { promotionId: p.id, discount };
    // priority already ordered desc; first eligible with max discount stands.
  }
  return best;
}
```

- [ ] **Step 4: Wire into `order.service.ts`**

Build `cartItems: CartItemForTargeting[]` from the resolved order items (productId, the product's category ids, quantity, line total) — the items are already loaded for subtotal; add category ids to that select if missing. Then, replacing the coupon-only block:

```ts
const custCtx = await resolveCustomerContext(storeId, { phone: customerPhone, email: customerEmail });
const targetingCtx = { ...custCtx, cartItems };

let couponDiscount = 0;
if (data.couponCode) {
  appliedCoupon = await CouponService.getByCode(storeId, data.couponCode);
  if (appliedCoupon.minOrderAmount && subtotal < appliedCoupon.minOrderAmount) throw /* MIN_ORDER_NOT_MET (unchanged) */;
  if (appliedCoupon.type === 'free_shipping') { shipping = 0; }
  else {
    const eval = CouponService.evaluateForCart(appliedCoupon, targetingCtx);
    if (!eval.eligible) throw new AppError(400, 'COUPON_NOT_ELIGIBLE', 'This coupon does not apply to your cart.');
    couponDiscount = eval.discount;
  }
}

const bestPromo = await resolveBestPromotion(storeId, targetingCtx);
const promotionDiscount = bestPromo ? bestPromo.discount : 0;

// Best-of: the larger single discount wins; loyalty stacks on the remainder.
const primaryDiscount = Math.max(couponDiscount, promotionDiscount);
const appliedPromotionId = bestPromo && promotionDiscount >= couponDiscount && promotionDiscount > 0 ? bestPromo.promotionId : null;
// When the promo wins over a coupon, drop the coupon usage increment (it wasn't applied).
```

Then set `const discount = primaryDiscount + loyaltyDiscount;` (loyalty context already caps against `subtotal - primaryDiscount`; update its `redeemableSubtotal` to use `primaryDiscount`). Persist `promotionDiscount` and `appliedPromotionId` in the order `create` data (near line 670). Only `incrementUsage` the coupon when the coupon actually won (`couponDiscount === primaryDiscount && couponDiscount > 0`) — guard the existing increment accordingly.

- [ ] **Step 5: Run resolver tests + full unit suite + typecheck**
      Run: `npx vitest run tests/unit/promotion-resolver.test.ts; echo $?` → PASS.
      Run: `npx vitest run tests/unit; echo $?` → all PASS (existing order tests still green).
      Run: `npx tsc --noEmit -p apps/api/tsconfig.json; echo $?` → 0.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/services/promotion-resolver.ts apps/api/src/services/order.service.ts tests/unit/promotion-resolver.test.ts
git commit -m "feat(order): apply automatic promotions and coupon targeting at checkout"
```

---

### Task 6: Preview endpoint

**Files:**

- Modify: `apps/api/src/routes/promotion.routes.ts` (add `POST /:storeId/promotions/preview`)
- Test: `tests/integration/promotions-preview.test.ts` (if an integration harness is present; else a service-level test using the resolver)

**Interfaces:**

- Consumes: `resolveCustomerContext`, `resolveBestPromotion`.
- Produces: `POST /stores/:storeId/promotions/preview` body `{ cartItems: {productId,categoryIds,quantity,lineTotal}[], phone?, email? }` → `{ promotion: { id, discount } | null }`.

- [ ] **Step 1:** Write a test asserting the endpoint returns the best promotion for an eligible cart and `null` for an empty/ineligible one.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Add the handler (public-ish: this runs for storefront shoppers, so mount it WITHOUT `authorize` but WITH `requireStoreAccess`? No — storefront is unauthenticated. Mount under the public store router instead, or gate only with `tenantContext` + rate limiting, mirroring how `/coupons/validate` is exposed). Match the exact auth posture of the existing `/coupons/validate` route (confirm whether it is public) and copy it.
- [ ] **Step 4:** Run → PASS; typecheck 0.
- [ ] **Step 5:** Commit `feat(api): promotion preview endpoint for storefront`.

---

### Task 7: Web checkout — show the applied promotion

**Files:**

- Modify: `apps/web/src/app/checkout/OrderSummary.tsx` (render a promotion discount line)
- Modify: `apps/web/src/app/checkout/CheckoutClient.tsx` (call the preview alongside coupon/summary; pass identity)

**Interfaces:**

- Consumes: `POST /stores/:storeId/promotions/preview`.

- [ ] **Step 1:** In `CheckoutClient.tsx`, when cart items or identity change, POST the cart + phone/email to `/api/v1/stores/${storeId}/promotions/preview`; store `{ id, discount }` in state.
- [ ] **Step 2:** In `OrderSummary.tsx`, when a promotion discount is present, render a labelled line (e.g. `t('checkout.promotionDiscount')`) above the total, formatted with the existing `formatPrice`. Ensure the displayed total still comes from the server on order creation (preview is display-only).
- [ ] **Step 3:** Add `checkout.promotionDiscount` to `apps/web/src/contexts/LanguageContext.tsx` translations (EN + AR).
- [ ] **Step 4:** Typecheck web: `npx tsc --noEmit -p apps/web/tsconfig.json; echo $?` → 0.
- [ ] **Step 5:** Commit `feat(web): show automatic promotion discount at checkout`.

---

### Task 8: Admin — promotions page + coupon targeting fields + i18n

**Files:**

- Create: `apps/admin/src/app/stores/[id]/promotions/page.tsx`
- Modify: the coupons admin form (find via `grep -rl "coupons" apps/admin/src/app/stores` — add the targeting controls)
- Modify: `apps/admin/src/i18n/messages/en.json` + `ar.json`
- Modify: admin nav/sidebar to add the Promotions link (same group as Coupons)

**Interfaces:**

- Consumes: `/stores/:storeId/promotions`, `/stores/:storeId/customer-groups` (group dropdown).

- [ ] **Step 1:** Build `/stores/[id]/promotions/page.tsx` mirroring `apps/admin/src/app/stores/[id]/customer-groups/page.tsx` (list + create/edit modal) with fields: name/nameAr, type (select), value, maxDiscount, priority, isActive, startsAt/expiresAt, and the targeting controls: customer-group `<select>` (fetched from `/customer-groups`), first-order-only checkbox, min-order-amount, min-quantity, and product/category scope pickers (multi-select; for Core, comma-or-picker of ids — reuse any existing product/category multiselect in the coupons form if present).
- [ ] **Step 2:** Add the same targeting controls to the coupons form.
- [ ] **Step 3:** Add all new keys to `en.json` + `ar.json` under `promotions.page` and the coupon form namespace; assert parity (`node -e` key-count check or the repo's i18n parity test).
- [ ] **Step 4:** Add the sidebar link. Typecheck admin: `npx tsc --noEmit -p apps/admin/tsconfig.json; echo $?` → 0. Lint admin: `npm run lint -w apps/admin; echo $?` → 0 errors.
- [ ] **Step 5:** Commit `feat(admin): promotions management page and coupon targeting fields`.

---

### Task 9: Blast-radius — new discount channel everywhere `couponDiscount` appears

**Files:** (identify exact lines by grep)

- `apps/api/src/services/invoice.service.ts`, `email-templates/order-confirmation.ts`, `accounting/posting/order-posting.ts`, `apps/api/src/routes/order.routes.ts` (order detail select + response), the admin order-detail view.

- [ ] **Step 1:** `grep -rn "couponDiscount" apps packages --include="*.ts" --include="*.tsx"` — for each surface that displays or posts the discount breakdown, add `promotionDiscount` alongside so invoices, the order-confirmation email, accounting postings, and the admin order view reflect the promotion discount (not just the coupon). The order total already includes it; this is about the itemized breakdown.
- [ ] **Step 2:** Run the full unit suite + api/admin/web typecheck; all green.
- [ ] **Step 3:** State the blast-radius result (per the D-GATE) in the PR: `swept Promotion · promotions · promotionDiscount · appliedPromotionId · scopeProductIds · scopeCategoryIds · customer_group_id across api/web/admin/accounting/email/invoice/CI/docs → …`.
- [ ] **Step 4:** Commit `feat(shared): surface promotion discount across invoice, email, accounting, order views`.

---

## Final verification (before PR)

- `npm run db:generate && npm run build -w packages/database -w packages/shared; echo $?` → 0
- `npx tsc --noEmit -p apps/api/tsconfig.json && npx tsc --noEmit -p apps/admin/tsconfig.json && npx tsc --noEmit -p apps/web/tsconfig.json; echo $?` → 0
- `npx vitest run tests/unit; echo $?` → all pass
- `npm run lint -w apps/api -w apps/admin -w apps/web` → 0 errors
- Update `handoff.md`; open PR stacked on #874; state the blast-radius result in the body.

## Self-Review (completed)

- **Spec coverage:** shared model+evaluator (T2), Promotion model/CRUD/UI (T1,T3,T8), coupon targeting (T1,T4), checkout best-of + group/first-order context (T5), preview + storefront (T6,T7), RLS (T1), money-integrity clamps (T2,T5), audit columns + breakdown surfaces (T1,T9). All spec sections map to a task.
- **Placeholders:** the pattern-following tasks (T3/T6/T8) reference exact in-repo sibling files to mirror (`coupon.service.ts`, `customer-group.service.ts`, `coupon.routes.ts`, `customer-groups/page.tsx`) rather than restating boilerplate — those are real, readable artifacts, not forward "Task N" references. Novel logic (evaluator, resolver, checkout diff, migration) is given in full.
- **Type consistency:** `Targeting`/`TargetingCtx`/`CartItemForTargeting`, `matchesTargeting`, `computeDiscount`, `evaluateForCart`, `resolveCustomerContext`, `resolveBestPromotion` names + signatures are consistent across T2/T4/T5/T6.
- **Open confirmation for the implementer:** T6 auth posture and T4 `/validate` public-vs-authenticated — resolve by copying the existing `/coupons/validate` route's exact posture (flagged inline).
