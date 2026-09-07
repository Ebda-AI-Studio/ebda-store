# Product Bundles (fixed kits) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a merchant sell a named fixed kit ("Ramadan Box — 12.000 KWD") that a customer buys as one item and receives as several.

**Architecture:** A `Bundle` + `BundleItem` pair defines the kit. The cart holds a bundle as its own row in a NEW `CartBundle` table — never expanded into `cart_items`. At order creation the bundle expands into ordinary `OrderItem` component lines sharing a `bundleGroupId`, with the bundle price allocated across them, so stock, scan-to-pick, returns, backorders and per-line COGS all keep working untouched. Every customer-facing surface renders the group as one row.

**Tech Stack:** Prisma 6 / Postgres (Neon), Hono on Cloudflare Workers (API), Next 16 App Router (web + admin), vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-09-06-product-bundles-design.md`

## Global Constraints

- **Strictly additive. This runs on live merchant stores.** New tables and NULLABLE columns only. No column is dropped, renamed, retyped, or made non-null. No existing index is altered.
- **`cart_items` and its two partial unique indexes are NOT touched.** They enforce `(cart_id, product_id)` uniqueness where `variant_id IS NULL`. Expanding a bundle into `cart_items` would violate them the moment a bundle contains a product the customer already has in their cart. This is why `CartBundle` exists.
- **Feature key `bundles`, `tier: 'addon'`, in NO plan baseline.** Every existing store gets it OFF. It is enabled per-store via `StoreFeature` only. Until it is enabled for a store, every code path added here is unreachable for that store.
- **All money is integer fils.** No floats anywhere in pricing. 1 KWD = 1000 fils.
- **Two money invariants, both tested, both mutation-tested:**
  1. `Σ(line.total)` across a bundle group `== bundlePrice` exactly.
  2. `line.price × line.quantity == line.total` for every line.
- **Prices are recomputed server-side at checkout.** Never trust a client-supplied bundle price.
- **Availability is derived, never stored:** `min(floor(availableStock_i / quantity_i))`.
- Arabic fields (`nameAr`, `descriptionAr`) accompany every customer-visible English field, per the bilingual standard.
- Each task ends green and independently shippable. Run `npm run typecheck` and the touched test files before every commit.

---

### Task 1: Schema — bundles, cart bundles, order tagging (additive only)

**Files:**

- Modify: `packages/database/prisma/schema.prisma`
- Create: `packages/database/prisma/migrations/20260906120000_product_bundles/migration.sql`
- Test: `tests/unit/bundle-schema.test.ts`

**Interfaces:**

- Consumes: nothing.
- Produces: models `Bundle`, `BundleItem`, `CartBundle`; enum `BundlePricingType`; nullable `OrderItem.bundleId | bundleGroupId | bundleName | bundleNameAr`; `Order.bundleDiscount Int @default(0)`.

- [ ] **Step 1: Add the enum and models to `schema.prisma`**

```prisma
enum BundlePricingType {
  fixed_price // value = the bundle's price in fils (e.g. 12000)
  percentage  // value = basis points off the component sum (12.5% -> 1250)
  fixed       // value = fils off the component sum
}

model Bundle {
  id            String            @id @default(uuid())
  storeId       String            @map("store_id")
  name          String
  nameAr        String?           @map("name_ar")
  slug          String
  description   String?
  descriptionAr String?           @map("description_ar")
  image         String?
  pricingType   BundlePricingType @map("pricing_type")
  pricingValue  Int               @map("pricing_value")
  isActive      Boolean           @default(true) @map("is_active")
  startsAt      DateTime?         @map("starts_at")
  expiresAt     DateTime?         @map("expires_at")
  createdAt     DateTime          @default(now()) @map("created_at")
  updatedAt     DateTime          @updatedAt @map("updated_at")

  store Store        @relation(fields: [storeId], references: [id], onDelete: Cascade)
  items BundleItem[]
  carts CartBundle[]

  @@unique([storeId, slug])
  @@index([storeId, isActive])
  @@map("bundles")
}

model BundleItem {
  id        String  @id @default(uuid())
  bundleId  String  @map("bundle_id")
  productId String  @map("product_id")
  variantId String? @map("variant_id")
  quantity  Int

  bundle  Bundle          @relation(fields: [bundleId], references: [id], onDelete: Cascade)
  product Product         @relation(fields: [productId], references: [id], onDelete: Restrict)
  variant ProductVariant? @relation(fields: [variantId], references: [id], onDelete: Restrict)

  @@unique([bundleId, productId, variantId])
  @@index([bundleId])
  @@index([productId])
  @@index([variantId])
  @@map("bundle_items")
}

model CartBundle {
  id        String   @id @default(uuid())
  cartId    String   @map("cart_id")
  bundleId  String   @map("bundle_id")
  quantity  Int      @default(1)
  createdAt DateTime @default(now()) @map("created_at")
  updatedAt DateTime @updatedAt @map("updated_at")

  cart   Cart   @relation(fields: [cartId], references: [id], onDelete: Cascade)
  bundle Bundle @relation(fields: [bundleId], references: [id], onDelete: Cascade)

  @@unique([cartId, bundleId])
  @@index([cartId])
  @@map("cart_bundles")
}
```

Add the back-relations: `bundles Bundle[]` on `Store`, `bundleItems BundleItem[]` on `Product`, `bundleItems BundleItem[]` on `ProductVariant`, `bundles CartBundle[]` on `Cart`.

- [ ] **Step 2: Add the nullable order columns**

On `OrderItem`:

```prisma
  bundleId      String? @map("bundle_id")
  bundleGroupId String? @map("bundle_group_id")
  bundleName    String? @map("bundle_name")
  bundleNameAr  String? @map("bundle_name_ar")
```

Plus `@@index([bundleGroupId])`. On `Order`:

```prisma
  bundleDiscount Int @default(0) @map("bundle_discount")
```

`bundleName` is a snapshot, deliberately not a join — a six-month-old invoice must still read "Ramadan Box" after the bundle is renamed or deleted, exactly as `productName` and `costPrice` already are.

- [ ] **Step 3: Generate the migration and read the SQL before trusting it**

Run: `npx prisma migrate dev --name product_bundles --create-only --schema packages/database/prisma/schema.prisma`

Then open the generated `migration.sql` and verify by reading, not assuming:

- every `ALTER TABLE ... ADD COLUMN` is nullable or has a DEFAULT
- there is no `DROP`, no `ALTER COLUMN ... SET NOT NULL`, no change to any `cart_items` index
- `bundle_items.product_id` FK is `ON DELETE RESTRICT`

- [ ] **Step 4: Write the guard test**

```typescript
// tests/unit/bundle-schema.test.ts
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

const MIG_DIR = resolve(__dirname, '../../packages/database/prisma/migrations');

function bundleMigrationSql(): string {
  const dir = readdirSync(MIG_DIR).find(d => d.includes('product_bundles'));
  if (!dir) throw new Error('product_bundles migration not found');
  return readFileSync(resolve(MIG_DIR, dir, 'migration.sql'), 'utf8');
}

describe('product bundles migration is additive', () => {
  const sql = bundleMigrationSql();

  it('drops nothing', () => {
    expect(sql).not.toMatch(/DROP\s+(TABLE|COLUMN|INDEX|CONSTRAINT)/i);
  });

  it('never makes an existing column NOT NULL', () => {
    expect(sql).not.toMatch(/ALTER\s+COLUMN[\s\S]*?SET\s+NOT\s+NULL/i);
  });

  it('does not touch cart_items or its partial unique indexes', () => {
    // Expanding a bundle into cart_items would violate
    // (cart_id, product_id) WHERE variant_id IS NULL the moment a bundle
    // contains a product already in the cart. CartBundle exists to avoid it.
    expect(sql).not.toMatch(/ALTER\s+TABLE\s+"?cart_items"?/i);
    expect(sql).toMatch(/CREATE\s+TABLE\s+"?cart_bundles"?/i);
  });

  it('restricts product deletion rather than cascading a live bundle away', () => {
    expect(sql).toMatch(/bundle_items[\s\S]*?ON DELETE RESTRICT/i);
  });

  it('adds order columns as nullable / defaulted only', () => {
    expect(sql).toMatch(/ALTER TABLE "?order_items"?[\s\S]*?ADD COLUMN "?bundle_group_id"?/i);
    expect(sql).toMatch(
      /ALTER TABLE "?orders"?[\s\S]*?ADD COLUMN "?bundle_discount"?[^;]*DEFAULT 0/i
    );
  });
});
```

- [ ] **Step 5: Run the test**

Run: `npx vitest run tests/unit/bundle-schema.test.ts`
Expected: PASS (5 tests). If "drops nothing" fails, the migration is unsafe — fix the schema, regenerate, do not hand-edit around the guard.

- [ ] **Step 6: Verify no drift and typecheck**

Run: `npx prisma generate --schema packages/database/prisma/schema.prisma && npm run build -w packages/database && npx tsc --noEmit -p apps/api/tsconfig.json`
Expected: exit 0.

- [ ] **Step 7: Commit**

```bash
git add packages/database/prisma/schema.prisma packages/database/prisma/migrations tests/unit/bundle-schema.test.ts
git commit -m "feat(db): additive schema for product bundles

New tables bundles / bundle_items / cart_bundles, nullable bundle tagging on
order_items, and orders.bundle_discount. Nothing reads any of it yet.

cart_items is deliberately untouched: its partial unique indexes on
(cart_id, product_id) WHERE variant_id IS NULL would be violated the moment a
bundle contained a product already in the customer's cart, so the cart holds a
bundle in its own table instead of expanding it. A guard test asserts the
migration drops nothing, sets nothing NOT NULL, and never alters cart_items."
```

---

### Task 2: Allocation and pricing library (pure, no DB)

**Files:**

- Create: `packages/shared/src/bundle-pricing.ts`
- Modify: `packages/shared/src/index.ts` (export it)
- Test: `tests/unit/bundle-pricing.test.ts`

**Interfaces:**

- Consumes: `BundlePricingType` from `@force/database` (or a local string union to keep this package DB-free — prefer the local union).
- Produces:
  - `computeBundlePrice(componentSum: number, pricingType: BundlePricingType, pricingValue: number): number`
  - `allocateBundlePrice(lines: BundleLine[], bundlePrice: number): AllocatedLine[]`
  - `isAllocatable(lines: BundleLine[], bundlePrice: number): boolean`
  - `type BundleLine = { key: string; unitPrice: number; quantity: number }`
  - `type AllocatedLine = BundleLine & { unitAllocated: number; totalAllocated: number }`

- [ ] **Step 1: Write the failing tests**

```typescript
// tests/unit/bundle-pricing.test.ts
import { describe, it, expect } from 'vitest';
import {
  computeBundlePrice,
  allocateBundlePrice,
  isAllocatable,
  type BundleLine,
} from '@force/shared';

// Ramadan Box: Dates 4.500 x1, Honey 6.000 x1, Nuts 2.000 x2 -> sum 14.500
const BOX: BundleLine[] = [
  { key: 'dates', unitPrice: 4500, quantity: 1 },
  { key: 'honey', unitPrice: 6000, quantity: 1 },
  { key: 'nuts', unitPrice: 2000, quantity: 2 },
];
const SUM = 14500;

describe('computeBundlePrice', () => {
  it('takes fixed_price literally', () => {
    expect(computeBundlePrice(SUM, 'fixed_price', 12000)).toBe(12000);
  });

  it('treats percentage as basis points off the sum', () => {
    // 15% of 14500 = 2175 -> 12325
    expect(computeBundlePrice(SUM, 'percentage', 1500)).toBe(12325);
  });

  it('treats fixed as fils off the sum', () => {
    expect(computeBundlePrice(SUM, 'fixed', 2500)).toBe(12000);
  });

  it('never returns a negative price', () => {
    expect(computeBundlePrice(SUM, 'fixed', 99999)).toBe(0);
  });
});

describe('allocateBundlePrice', () => {
  it('sums to the bundle price EXACTLY (invariant 1)', () => {
    const out = allocateBundlePrice(BOX, 12000);
    expect(out.reduce((s, l) => s + l.totalAllocated, 0)).toBe(12000);
  });

  it('keeps unit x quantity == total on every line (invariant 2)', () => {
    for (const l of allocateBundlePrice(BOX, 12000)) {
      expect(l.unitAllocated * l.quantity).toBe(l.totalAllocated);
    }
  });

  it('matches the worked example in the spec', () => {
    const byKey = Object.fromEntries(
      allocateBundlePrice(BOX, 12000).map(l => [l.key, l.totalAllocated])
    );
    expect(byKey).toEqual({ dates: 3724, honey: 4966, nuts: 3310 });
  });

  it('is deterministic across repeated calls', () => {
    expect(allocateBundlePrice(BOX, 12000)).toEqual(allocateBundlePrice(BOX, 12000));
  });

  it('holds both invariants across many prices (property check)', () => {
    for (let price = 1; price <= SUM; price += 7) {
      if (!isAllocatable(BOX, price)) continue;
      const out = allocateBundlePrice(BOX, price);
      expect(out.reduce((s, l) => s + l.totalAllocated, 0)).toBe(price);
      for (const l of out) expect(l.unitAllocated * l.quantity).toBe(l.totalAllocated);
    }
  });

  it('handles a zero-priced component without dividing by zero', () => {
    const withFree: BundleLine[] = [
      { key: 'main', unitPrice: 5000, quantity: 1 },
      { key: 'gift', unitPrice: 0, quantity: 1 },
    ];
    const out = allocateBundlePrice(withFree, 4000);
    expect(out.reduce((s, l) => s + l.totalAllocated, 0)).toBe(4000);
  });
});

describe('isAllocatable', () => {
  it('accepts a price that splits exactly', () => {
    expect(isAllocatable(BOX, 12000)).toBe(true);
  });

  it('rejects a price no split can represent', () => {
    // Every quantity is 2, so every line total is even; an odd price cannot
    // be represented without breaking unit x quantity == total.
    const allPairs: BundleLine[] = [
      { key: 'a', unitPrice: 1000, quantity: 2 },
      { key: 'b', unitPrice: 3000, quantity: 2 },
    ];
    expect(isAllocatable(allPairs, 4001)).toBe(false);
    expect(isAllocatable(allPairs, 4000)).toBe(true);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/unit/bundle-pricing.test.ts`
Expected: FAIL — `computeBundlePrice is not exported` / module not found.

- [ ] **Step 3: Implement the library**

```typescript
// packages/shared/src/bundle-pricing.ts
/**
 * Bundle price + allocation. Integer fils throughout — no floats, ever.
 *
 * Allocation runs on UNIT shares, not line totals, because OrderItem stores
 * both a unit `price` and a `total`. A line total that is not divisible by its
 * quantity cannot be stored without one of those two lying.
 */

export type BundlePricingType = 'fixed_price' | 'percentage' | 'fixed';

export interface BundleLine {
  key: string;
  unitPrice: number; // fils, the component's effective unit price
  quantity: number; // >= 1
}

export interface AllocatedLine extends BundleLine {
  unitAllocated: number;
  totalAllocated: number;
}

/** Price of the bundle in fils, given the sum of its components. */
export function computeBundlePrice(
  componentSum: number,
  pricingType: BundlePricingType,
  pricingValue: number
): number {
  let price: number;
  switch (pricingType) {
    case 'fixed_price':
      price = pricingValue;
      break;
    case 'percentage':
      // basis points: 12.5% -> 1250. Floor the discount so rounding favours
      // the merchant rather than silently discounting an extra fil.
      price = componentSum - Math.floor((componentSum * pricingValue) / 10000);
      break;
    case 'fixed':
      price = componentSum - pricingValue;
      break;
  }
  return Math.max(0, Math.min(price, componentSum));
}

/**
 * Split `bundlePrice` across `lines` by value weight.
 *
 * Guarantees, when `isAllocatable(lines, bundlePrice)`:
 *   1. sum(totalAllocated) === bundlePrice
 *   2. unitAllocated * quantity === totalAllocated for every line
 */
export function allocateBundlePrice(lines: BundleLine[], bundlePrice: number): AllocatedLine[] {
  const weights = lines.map(l => l.unitPrice * l.quantity);
  const totalWeight = weights.reduce((a, b) => a + b, 0);

  // Degenerate: every component is free. Spread evenly by quantity instead of
  // dividing by zero.
  const raw = lines.map((l, i) =>
    totalWeight === 0
      ? (bundlePrice * l.quantity) / lines.reduce((s, x) => s + x.quantity, 0)
      : (bundlePrice * weights[i]) / totalWeight
  );

  const out: AllocatedLine[] = lines.map((l, i) => {
    const unit = Math.floor(raw[i] / l.quantity);
    return { ...l, unitAllocated: unit, totalAllocated: unit * l.quantity };
  });

  let residual = bundlePrice - out.reduce((s, l) => s + l.totalAllocated, 0);

  // Largest fractional remainder first. Adding 1 to a unit adds `quantity` to
  // that line, so only lines that fit inside the residual are eligible.
  const order = out
    .map((l, i) => ({ i, frac: raw[i] / l.quantity - l.unitAllocated }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i);

  let progress = true;
  while (residual > 0 && progress) {
    progress = false;
    for (const { i } of order) {
      const q = out[i].quantity;
      if (q <= residual) {
        out[i].unitAllocated += 1;
        out[i].totalAllocated += q;
        residual -= q;
        progress = true;
        if (residual === 0) break;
      }
    }
  }
  return out;
}

/** True when `bundlePrice` can be split with both invariants intact. */
export function isAllocatable(lines: BundleLine[], bundlePrice: number): boolean {
  if (bundlePrice < 0) return false;
  const out = allocateBundlePrice(lines, bundlePrice);
  return out.reduce((s, l) => s + l.totalAllocated, 0) === bundlePrice;
}
```

- [ ] **Step 4: Export from the package index**

Add to `packages/shared/src/index.ts`:

```typescript
export * from './bundle-pricing';
```

- [ ] **Step 5: Run the tests**

Run: `npm run build -w packages/shared && npx vitest run tests/unit/bundle-pricing.test.ts`
Expected: PASS (all).

- [ ] **Step 6: Mutation-test the money invariants — a green suite that cannot fail is not evidence**

Temporarily change `residual -= q;` to `residual -= q + 1;` in `allocateBundlePrice`, rerun, and confirm "sums to the bundle price EXACTLY" **fails by name**. Then restore the line byte-identically and confirm green again. Record the result in the commit message.

- [ ] **Step 7: Commit**

```bash
git add packages/shared/src/bundle-pricing.ts packages/shared/src/index.ts tests/unit/bundle-pricing.test.ts
git commit -m "feat(shared): bundle price + fils-exact allocation

Allocation runs on unit shares rather than line totals because OrderItem stores
both a unit price and a total; a line total not divisible by its quantity can
not be represented without one of them lying.

Both money invariants are asserted and mutation-tested: breaking the residual
distribution reddens 'sums to the bundle price EXACTLY' by name."
```

---

### Task 3: Availability + bundle read service

**Files:**

- Create: `apps/api/src/services/bundle.service.ts`
- Test: `tests/unit/bundle-availability.test.ts`

**Interfaces:**

- Consumes: `allocateBundlePrice`, `computeBundlePrice` from `@force/shared`.
- Produces:
  - `bundleAvailability(items: AvailabilityItem[]): number`
  - `type AvailabilityItem = { quantity: number; trackInventory: boolean; availableStock: number }`
  - `resolveBundle(prisma, storeId, bundleId)` → `ResolvedBundle { id, name, nameAr, slug, image, componentSum, price, available, lines }`

- [ ] **Step 1: Write the failing availability tests**

```typescript
// tests/unit/bundle-availability.test.ts
import { describe, it, expect } from 'vitest';
import { bundleAvailability } from '../../apps/api/src/services/bundle.service';

const item = (quantity: number, availableStock: number, trackInventory = true) => ({
  quantity,
  availableStock,
  trackInventory,
});

describe('bundleAvailability', () => {
  it('is limited by the scarcest component', () => {
    // Dates 40/1, Honey 12/1, Nuts 30/2 -> min(40, 12, 15) = 12
    expect(bundleAvailability([item(1, 40), item(1, 12), item(2, 30)])).toBe(12);
  });

  it('floors rather than rounds — 5 nuts cannot make 3 boxes of 2', () => {
    expect(bundleAvailability([item(2, 5)])).toBe(2);
  });

  it('is zero when any component is out of stock', () => {
    expect(bundleAvailability([item(1, 40), item(1, 0)])).toBe(0);
  });

  it('ignores components that do not track inventory', () => {
    expect(bundleAvailability([item(1, 7), item(1, 0, false)])).toBe(7);
  });

  it('is zero for a bundle with no items — never Infinity', () => {
    expect(bundleAvailability([])).toBe(0);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/unit/bundle-availability.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```typescript
// apps/api/src/services/bundle.service.ts
export interface AvailabilityItem {
  quantity: number;
  trackInventory: boolean;
  availableStock: number;
}

/**
 * How many whole bundles the component stock can make.
 *
 * DERIVED on every read, never stored. A stored count drifts the moment any
 * component's stock moves through any other path (orders, bulk edit, import,
 * returns), and inventory is a NEVER-stale class value.
 *
 * An empty bundle returns 0, not Infinity: `Math.min()` of nothing is
 * Infinity, which would make a contentless bundle infinitely purchasable.
 */
export function bundleAvailability(items: AvailabilityItem[]): number {
  if (items.length === 0) return 0;
  let min = Number.POSITIVE_INFINITY;
  for (const it of items) {
    if (!it.trackInventory) continue;
    min = Math.min(min, Math.floor(it.availableStock / it.quantity));
  }
  return min === Number.POSITIVE_INFINITY ? Number.MAX_SAFE_INTEGER : Math.max(0, min);
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/unit/bundle-availability.test.ts`
Expected: PASS (5).

- [ ] **Step 5: Add `resolveBundle`** — loads the bundle with items, products and variants for `storeId`, computes each line's effective unit price via `cartLineUnitPrice`, sums to `componentSum`, derives `price` via `computeBundlePrice`, derives `available` via `bundleAvailability`, and returns `lines` ready for `allocateBundlePrice`. It MUST filter by `storeId` and throw (never default to the first store) when the bundle does not belong to the store — the tenant-resolver rule.

- [ ] **Step 6: Typecheck and commit**

```bash
npx tsc --noEmit -p apps/api/tsconfig.json
git add apps/api/src/services/bundle.service.ts tests/unit/bundle-availability.test.ts
git commit -m "feat(api): derived bundle availability + bundle resolver

Availability is min(floor(stock/qty)) computed on read, never stored. An empty
bundle returns 0 rather than Infinity, and resolveBundle throws on a
store mismatch instead of defaulting to the first store."
```

---

### Task 4: Feature key + admin CRUD API

**Files:**

- Modify: `packages/shared/src/features.ts` (add `bundles`)
- Modify: `packages/shared/src/plan-baselines.ts` (add to NO baseline — comment why)
- Create: `apps/api/src/routes/bundle.routes.ts`
- Modify: `apps/api/src/routes/index.ts` (register)
- Test: `tests/unit/bundle-validation.test.ts`

**Interfaces:**

- Consumes: `resolveBundle`, `isAllocatable`.
- Produces: `POST/PATCH/DELETE /api/v1/admin/bundles`, `GET /api/v1/public/bundles`, all `bundles`-feature-gated.

- [ ] **Step 1: Add the feature key**

```typescript
// packages/shared/src/features.ts — inside FEATURE_REGISTRY
  bundles: {
    key: 'bundles',
    name: 'Product Bundles',
    nameAr: 'باقات المنتجات',
    description:
      'Sell a fixed kit of products as one item at one price. Stock is drawn from the ' +
      'component products, so nothing is double-counted.',
    descriptionAr:
      'بيع مجموعة ثابتة من المنتجات كعنصر واحد بسعر واحد. يُخصم المخزون من المنتجات ' +
      'المكوّنة، فلا يُحتسب أي صنف مرتين.',
    category: 'commerce',
    tier: 'addon',
  },
```

Add `'bundles'` to the `FeatureKey` union. In `plan-baselines.ts` add a comment and NOT the key:

```typescript
// 'bundles' is deliberately in NO baseline — it is sold per store and enabled
// via a StoreFeature override, so every existing merchant is unaffected.
```

- [ ] **Step 2: Write the validation test**

```typescript
// tests/unit/bundle-validation.test.ts
import { describe, it, expect } from 'vitest';
import { isAllocatable, type BundleLine } from '@force/shared';
import { nearestAllocatablePrice } from '../../apps/api/src/routes/bundle.routes';

const ALL_PAIRS: BundleLine[] = [
  { key: 'a', unitPrice: 1000, quantity: 2 },
  { key: 'b', unitPrice: 3000, quantity: 2 },
];

describe('admin-time price validation', () => {
  it('suggests the nearest representable price instead of failing at checkout', () => {
    expect(isAllocatable(ALL_PAIRS, 4001)).toBe(false);
    expect(nearestAllocatablePrice(ALL_PAIRS, 4001)).toBe(4000);
  });

  it('returns the price unchanged when it already splits', () => {
    expect(nearestAllocatablePrice(ALL_PAIRS, 4000)).toBe(4000);
  });

  it('rejects a bundle with no items', () => {
    expect(isAllocatable([], 1000)).toBe(false);
  });
});
```

- [ ] **Step 3: Run to verify it fails, then implement the routes**

`nearestAllocatablePrice` walks outward from the requested price (±1, ±2 …, capped at the component sum) and returns the first `isAllocatable` value. The admin save endpoint returns `422 { error: 'price_not_allocatable', suggested }` so the merchant sees the problem while configuring, never a customer at checkout.

Every route is wrapped in the existing feature gate for `bundles` and the existing tenant-context middleware. Zod-validate every input at the edge.

- [ ] **Step 4: Run tests, typecheck, commit**

```bash
npx vitest run tests/unit/bundle-validation.test.ts && npx tsc --noEmit -p apps/api/tsconfig.json
git add packages/shared/src/features.ts packages/shared/src/plan-baselines.ts apps/api/src/routes/bundle.routes.ts apps/api/src/routes/index.ts tests/unit/bundle-validation.test.ts
git commit -m "feat(api): bundles feature key + admin CRUD with save-time price validation

The feature is in NO plan baseline, so every existing store has it off until a
super-admin enables it. An unrepresentable bundle price is rejected at SAVE
time with a suggested nearest value, so the edge case reaches the merchant
while configuring rather than a customer at checkout."
```

---

### Task 5: Cart holds bundles (never expanded into cart_items)

**Files:**

- Modify: `apps/api/src/routes/cart.routes.ts`
- Modify: `apps/api/src/services/cart.service.ts`
- Test: `tests/integration/cart-bundles.test.ts`

**Interfaces:**

- Consumes: `resolveBundle`, `bundleAvailability`.
- Produces: `POST /cart/bundles { bundleId, quantity }`, `DELETE /cart/bundles/:id`; cart response gains `bundles: CartBundleView[]` with `{ id, bundleId, name, nameAr, image, quantity, unitPrice, total, available }`.

- [ ] **Step 1: Write the integration test that proves the constraint is not hit**

```typescript
// tests/integration/cart-bundles.test.ts
// The regression this exists to prevent: a customer with Dates already in the
// cart adds a bundle that CONTAINS Dates. If bundles expanded into cart_items,
// this violates the partial unique index on (cart_id, product_id) WHERE
// variant_id IS NULL and the request 500s.
it('accepts a bundle containing a product already in the cart', async () => {
  await addToCart({ productId: dates.id, quantity: 1 });
  const res = await addBundleToCart({ bundleId: ramadanBox.id, quantity: 1 });
  expect(res.status).toBe(200);
  const cart = await getCart();
  expect(cart.items).toHaveLength(1); // the standalone dates, untouched
  expect(cart.bundles).toHaveLength(1); // the box, in its own row
});

it('refuses a quantity the component stock cannot make', async () => {
  await setStock(honey.id, 1);
  const res = await addBundleToCart({ bundleId: ramadanBox.id, quantity: 2 });
  expect(res.status).toBe(422);
  expect(await res.json()).toMatchObject({ error: 'insufficient_stock' });
});
```

- [ ] **Step 2: Run to verify it fails, then implement**

Cart totals become `Σ(item lines) + Σ(bundle.price × bundle.quantity)`. The bundle price is recomputed on every cart read from current component prices — never cached on `CartBundle`, so a component price change is reflected before the customer pays.

- [ ] **Step 3: Run tests, typecheck, commit**

```bash
git add apps/api/src/routes/cart.routes.ts apps/api/src/services/cart.service.ts tests/integration/cart-bundles.test.ts
git commit -m "feat(api): cart holds bundles in their own rows

A bundle never expands into cart_items: that would violate the partial unique
index on (cart_id, product_id) the moment a bundle contained a product the
customer already had. Regression test covers exactly that case. Bundle price is
recomputed on every cart read, never cached."
```

---

### Task 6: Order creation expands bundles into component lines

**Files:**

- Modify: `apps/api/src/services/order.service.ts` (the `items: { create: cart.items.map(...) }` site, ~line 830)
- Test: `tests/integration/order-bundles.test.ts`

**Interfaces:**

- Consumes: `resolveBundle`, `allocateBundlePrice`.
- Produces: order items tagged with `bundleId`/`bundleGroupId`/`bundleName`; `Order.bundleDiscount`.

- [ ] **Step 1: Write the failing integration tests**

```typescript
it('writes one component line per bundle item, sharing a bundleGroupId', async () => {
  const order = await checkoutWithBundle(ramadanBox.id, 1);
  const group = order.items.filter(i => i.bundleGroupId);
  expect(group).toHaveLength(3);
  expect(new Set(group.map(i => i.bundleGroupId)).size).toBe(1);
  expect(group.every(i => i.bundleName === 'Ramadan Box')).toBe(true);
});

it('allocates the bundle price across the lines exactly', async () => {
  const order = await checkoutWithBundle(ramadanBox.id, 1);
  const group = order.items.filter(i => i.bundleGroupId);
  expect(group.reduce((s, i) => s + i.total, 0)).toBe(12000);
  for (const i of group) expect(i.price * i.quantity).toBe(i.total);
});

it('writes one group PER BOX so a single box can be returned', async () => {
  const order = await checkoutWithBundle(ramadanBox.id, 2);
  expect(new Set(order.items.filter(i => i.bundleGroupId).map(i => i.bundleGroupId)).size).toBe(2);
});

it('decrements component stock, not any bundle counter', async () => {
  const before = await stockOf(honey.id);
  await checkoutWithBundle(ramadanBox.id, 1);
  expect(await stockOf(honey.id)).toBe(before - 1);
});

it('does not oversell the last box under concurrent checkout', async () => {
  await setStock(honey.id, 1);
  const [a, b] = await Promise.allSettled([
    checkoutWithBundle(ramadanBox.id, 1),
    checkoutWithBundle(ramadanBox.id, 1),
  ]);
  const ok = [a, b].filter(r => r.status === 'fulfilled');
  expect(ok).toHaveLength(1);
  expect(await stockOf(honey.id)).toBe(0);
});
```

- [ ] **Step 2: Run to verify they fail, then implement**

Expansion happens INSIDE the existing order-creation transaction, appending to the same `items.create` array, so the existing stock check/decrement path covers the component lines with no second code path. `Order.bundleDiscount = Σ(componentSum − bundlePrice) × quantity`.

- [ ] **Step 3: Run tests, typecheck, commit**

```bash
git add apps/api/src/services/order.service.ts tests/integration/order-bundles.test.ts
git commit -m "feat(api): expand bundles into component order lines at checkout

Expansion happens inside the existing order-creation transaction so the current
stock check and decrement cover component lines with no second code path. One
group per box, so returning a single box out of two is expressible. Both money
invariants asserted; concurrent checkout of the last box oversells nothing."
```

---

### Task 7: Atomic returns

**Files:**

- Modify: `apps/api/src/services/return.service.ts`
- Test: `tests/integration/bundle-returns.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
it('refunds exactly the bundle price for a returned box', async () => {
  const order = await checkoutWithBundle(ramadanBox.id, 1);
  const r = await createReturn({ orderId: order.id, bundleGroupId: groupOf(order) });
  expect(r.refundAmount).toBe(12000);
});

it('restocks every component of a returned box', async () => {
  const order = await checkoutWithBundle(ramadanBox.id, 1);
  const before = await stockOf(nuts.id);
  await completeReturn({ orderId: order.id, bundleGroupId: groupOf(order) });
  expect(await stockOf(nuts.id)).toBe(before + 2);
});

it('refuses a partial return of one component while returns are atomic', async () => {
  const order = await checkoutWithBundle(ramadanBox.id, 1);
  const honeyLine = order.items.find(i => i.productId === honey.id)!;
  const res = await createReturn({
    orderId: order.id,
    items: [{ orderItemId: honeyLine.id, quantity: 1 }],
  });
  expect(res.status).toBe(422);
  expect(await res.json()).toMatchObject({ error: 'bundle_returns_are_atomic' });
});
```

- [ ] **Step 2: Implement, run, commit**

```bash
git commit -m "feat(api): atomic bundle returns

A bundle group returns as a unit: refund is the sum of its allocated line
totals (exactly the bundle price) and every component restocks. Selecting a
single component line from a group is refused with bundle_returns_are_atomic.
Itemized returns remain a later UI change, not a migration, because the
allocated share is already stored per line."
```

---

### Task 8: Storefront — one row, never the split

**Files:**

- Modify: `apps/web/src/app/cart/page.tsx`, `apps/web/src/app/checkout/page.tsx`, order-confirmation and invoice templates
- Create: `apps/web/src/components/BundleLine.tsx`
- Test: `tests/e2e/bundle-checkout.spec.ts`

- [ ] **Step 1: Write the E2E assertion that the split is invisible**

```typescript
it('shows the box as ONE row and never the per-item allocation', async ({ page }) => {
  await addBundleAndOpenCart(page);
  await expect(page.getByTestId('cart-line')).toHaveCount(1);
  await expect(page.getByText('Ramadan Box')).toBeVisible();
  await expect(page.getByText('12.000')).toBeVisible();
  // the allocated shares must not appear anywhere on the page
  for (const share of ['3.724', '4.966', '3.310']) {
    await expect(page.getByText(share)).toHaveCount(0);
  }
});
```

- [ ] **Step 2: Implement, run, commit.** Admin, picking and returns DO show components — those users need to know what to put in the box.

---

### Task 9: Admin UI

**Files:**

- Create: `apps/admin/src/app/stores/[id]/bundles/page.tsx` (+ form components), mirroring `stores/[id]/promotions`

Bundle list, create/edit with a product picker and quantity per item, live component sum, live derived availability, and the `price_not_allocatable` suggestion surfaced inline as "12.000 can't be split across these items — use 11.999?".

---

### Task 10: WhatsApp bot catalogue + AI product feed

**Files:**

- Modify: the FWB→WBS catalogue bridge payload; `apps/web/src/app/feeds/products.json/route.ts`
- Modify: WBS `backend/src/services/wa-ordering.js` catalogue cache

Bundles appear as orderable entries with their derived availability. A box that sells on the web but not in DMs is a bug someone reports later. The bot's cart hand-off carries `bundleId`, and the existing signed-token checkout path expands it exactly as the web cart does.

---

### Task 11: Documentation parity

**Files:**

- Modify: `docs/business/04-pricing-tiers.md` — **remove the "+ bundles" claim from `upsell_crosssell`** and add a `bundles` add-on band
- Modify: `docs/business/02-feature-catalog.md`, `docs/business/plan-feature-matrix.md`

- [ ] **Commit**

```bash
git commit -m "docs: correct the upsell_crosssell 'bundles' overclaim, document the bundles add-on

04-pricing-tiers.md sold upsell_crosssell as 'recommendations + bundles'. The
bundles half did not exist when that was written; a rep quoting it was
promising unbuilt software."
```

---

## Blast-radius sweep (run before the final PR, state the result)

One consolidated pass over `bundleId`, `bundleGroupId`, `bundleDiscount`, `bundles` (feature key), `cart_bundles`, `BundlePricingType` across: every `OrderItem` consumer (returns, backorders, picking, COGS, XLSX export, analytics); product delete + cascade handlers and `information_schema.referential_constraints` for the new `RESTRICT` FK; catalogue/search/sitemap; `/feeds/products.json`; the WBS catalogue cache and intent classifier; abandoned-cart; `plan-feature-matrix.md`, `02-feature-catalog.md`, `04-pricing-tiers.md`; and `.env.example` (no new env vars expected — confirm).

## Rollout

1. Merge with `bundles` in no baseline — **zero effect on every existing store**.
2. Enable `StoreFeature bundles` for the asking merchant only.
3. Build one real bundle, place one real order, complete one real return.
4. Only then offer it to other merchants.

## Open rulings for Ahmad (defaults applied unless he says otherwise)

- **B1** — bundles are excluded from coupons and cart promotions. Stacking would discount the same items twice and can drive a box below cost.
- **Pricing-doc fix** — done in Task 11, not deferred.
- **Bundle URL** — bundles get `/bundles/<slug>` with sitemap + OG, because sharing a seasonal offer on WhatsApp and Instagram is the point. Task 8 covers the page.
