# Variant Stock Drift — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `products.inventory` mean exactly one thing — the on-hand stock of a product that has **no** variants — so that a variant product's stock lives only on its variants, and no reader or writer can silently corrupt it or read a stale number from it.

**Architecture:** Today `products.inventory` is written by two different mental models. Checkout, refund, rollback and PO-receive all treat it as a running total that "shadows" the variants; `enrichStockFlags`, `postAdjustment` and the admin grid treat it as unused-for-variant-products. The second model is the documented one. This plan makes it the **only** model: (a) every writer touches the variant _or_ the product, never both — the pattern `stock-adjustment.service.ts:135-145` already uses correctly; (b) every reader that needs "is this product available" goes through one shared helper instead of dereferencing `.inventory`; (c) a migration zeroes the 63 variant products still carrying a non-zero parent; (d) variant writes bust the storefront cache like every other stock write already does.

**Tech Stack:** TypeScript, Express, Prisma 6 / PostgreSQL (Neon), Vitest, Turborepo monorepo (`apps/api`, `apps/admin`, `apps/web`, `packages/database`).

**Spec:** This plan is its own spec — the defect was diagnosed directly against production. Diagnostic evidence is reproduced in "Root cause" below.

---

## Root cause

`apps/api/src/services/order.service.ts:657` — every variant sale _also_ decrements the parent:

```ts
if (variantId) {
  const prod = await forceDecrementProductInventory(tx, item.productId, qty);
```

`forceDecrementProductInventory` (`inventory-decrement.ts:49`) is **unfloored**, unlike its variant twin at `:88` which uses `GREATEST(0, …)`. A variant product's parent column starts at 0 (the merchant puts stock on the variants), so it only ever goes down. It is not stock — it is a negative sale counter.

Measured against production (read-only), 2026-08-30:

| Metric                                                              | Count       |
| ------------------------------------------------------------------- | ----------- |
| Products with negative `inventory`                                  | 24          |
| …that have variants                                                 | **24 / 24** |
| Variant products where parent ≠ Σ variant inventory                 | 166 / 191   |
| **Active variant products where a cart quantity change hard-fails** | **92**      |

Example: `Dehydrated Super Vegetable` (pecannbee) — parent `-16`, variant stock `1173`.

The symptom the merchant sees ("stays out of stock even after I update the variant") is
`apps/api/src/services/cart.service.ts:369`, which checks the drifted parent column and never
looks at `item.variantId`. Its siblings `addItem` (`:151`) and `validate` (`:285`) both do
`variant ? variant.inventory : product.inventory` — only `updateItem` was missed.

## Global Constraints

- **Money/stock paths are live.** `pecannbee` is a production store. Every change to `order.service.ts`, `order-refunded.ts` and `purchase-order.service.ts` must preserve existing behaviour for **non-variant** products byte-for-byte.
- **The invariant, stated once:** for a product with ≥1 `ProductVariant` row, `products.inventory` is **not** stock and MUST remain `0`. Stock is `SUM(product_variants.inventory)`. For a product with no variants, `products.inventory` is the stock.
- **One writer per row.** A single order/refund/adjustment line writes the variant row **or** the product row, never both. Reference implementation: `apps/api/src/services/accounting/stock-adjustment.service.ts:135-145`.
- **Fail loud, never silently no-op.** A product-scoped stock write aimed at a variant product returns a 400, it does not write a meaningless column (per `feedback-tenant-resolver-throw-not-default`).
- **Every stock write busts the cache.** `apps/api/src/lib/public-cache.ts` states that any write changing price or stock MUST call `invalidateStoreProductCaches`. Variant writes currently do not.
- Fils are integers. Prices/costs never become floats.
- Commit per task. Branch: `fix/variant-stock-drift`, worktree `_worktrees/force-website-builder__fix-variant-stock-drift`.

---

## File Structure

| File                                                                                             | Responsibility                                                                                                                                          | Task |
| ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- |
| `apps/api/src/lib/effective-inventory.ts`                                                        | **New.** The single definition of "stock of a product, variants considered" + the Prisma select fragment that feeds it. Every reader imports from here. | 1    |
| `apps/api/src/services/cart.service.ts`                                                          | `updateItem` must resolve stock through the cart line's variant.                                                                                        | 2    |
| `apps/api/src/services/inventory-decrement.ts`                                                   | Delete the unfloored product force-decrement — nothing may call it after Task 3.                                                                        | 3    |
| `apps/api/src/services/order.service.ts`                                                         | Variant lines stop touching the parent, on both the sale and the payment-rollback path.                                                                 | 3    |
| `apps/api/src/lib/inngest/functions/order-refunded.ts`                                           | Refund restore stops touching the parent for variant lines.                                                                                             | 3    |
| `apps/api/src/services/accounting/purchase-order.service.ts`                                     | Receive stops writing parent `inventory` for variant lines; WAC uses variant-aware on-hand.                                                             | 4    |
| `apps/api/src/services/inventory.service.ts`                                                     | Product-scoped adjust/bulk-adjust reject variant products instead of corrupting them.                                                                   | 4    |
| `apps/api/src/services/product.service.ts`                                                       | `advancedSearch`'s `inStock` filter becomes variant-aware.                                                                                              | 5    |
| `apps/api/src/routes/wa-bridge.routes.ts`                                                        | 3 catalog `inStock` flags + the order stock check become variant-aware.                                                                                 | 5    |
| `apps/api/src/routes/payment-links.routes.ts`                                                    | Stock check becomes variant-aware.                                                                                                                      | 5    |
| `apps/api/src/services/inventory/low-stock-scan.service.ts`                                      | Low-stock alerts evaluate variant-aware stock.                                                                                                          | 6    |
| `apps/api/src/services/accounting/deadstock-scan.service.ts`                                     | Dead-stock value uses variant-aware on-hand.                                                                                                            | 6    |
| `apps/api/src/services/variant.service.ts`                                                       | Every variant write busts the store's product caches.                                                                                                   | 7    |
| `apps/admin/.../ProductInfoSections.tsx`                                                         | Admin PDP shows variant-aware stock and treats ≤ 0 as out-of-stock.                                                                                     | 8    |
| `packages/database/prisma/migrations/20260830090000_zero_variant_parent_inventory/migration.sql` | **New.** Zero the parent column on the 63 variant products still carrying one.                                                                          | 9    |
| `tests/unit/effective-inventory.test.ts`                                                         | **New.**                                                                                                                                                | 1    |
| `tests/unit/cart-variant-stock.test.ts`                                                          | **New.**                                                                                                                                                | 2    |
| `tests/unit/order-variant-stock-isolation.test.ts`                                               | **New.**                                                                                                                                                | 3    |
| `tests/unit/variant-cache-invalidation.test.ts`                                                  | **New.**                                                                                                                                                | 7    |

---

### Task 1: The shared `effectiveInventory` helper

Every reader currently writes its own version of "how much stock is there". Six of them got it
wrong. This task creates the one definition they will all import.

**Files:**

- Create: `apps/api/src/lib/effective-inventory.ts`
- Test: `tests/unit/effective-inventory.test.ts`

**Interfaces:**

- Consumes: nothing.
- Produces:
  - `EFFECTIVE_STOCK_SELECT` — a Prisma `select` fragment: `{ inventory: true, trackInventory: true, allowBackorder: true, variants: { select: { inventory: true, allowBackorder: true } } }`
  - `effectiveInventory(p: StockShape): number`
  - `isOrderable(p: StockShape, qty: number, backorderFeatureEnabled: boolean): boolean`
  - `interface StockShape { inventory: number; trackInventory?: boolean; allowBackorder?: boolean; variants?: Array<{ inventory: number; allowBackorder?: boolean }> | null }`

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/effective-inventory.test.ts
import { describe, it, expect } from 'vitest';
import { effectiveInventory, isOrderable } from '@api/lib/effective-inventory';

describe('effectiveInventory', () => {
  it('returns the product column when the product has no variants', () => {
    expect(effectiveInventory({ inventory: 7, variants: [] })).toBe(7);
    expect(effectiveInventory({ inventory: 7 })).toBe(7);
    expect(effectiveInventory({ inventory: 7, variants: null })).toBe(7);
  });

  it('sums the variants and ignores the parent column when variants exist', () => {
    expect(
      effectiveInventory({ inventory: -16, variants: [{ inventory: 1000 }, { inventory: 173 }] })
    ).toBe(1173);
  });

  it('never lets a corrupted negative parent leak through a variant product', () => {
    // The exact production shape: parent drifted negative, variants hold real stock.
    expect(effectiveInventory({ inventory: -16, variants: [{ inventory: 1173 }] })).toBe(1173);
  });

  it('returns 0, not the parent, for a variant product whose variants are empty', () => {
    expect(effectiveInventory({ inventory: -4, variants: [{ inventory: 0 }] })).toBe(0);
  });
});

describe('isOrderable', () => {
  const enabled = true;

  it('is always orderable when the product does not track inventory', () => {
    expect(isOrderable({ inventory: -16, trackInventory: false }, 5, enabled)).toBe(true);
  });

  it('uses variant stock for a variant product', () => {
    const p = { inventory: -16, trackInventory: true, variants: [{ inventory: 1173 }] };
    expect(isOrderable(p, 3, enabled)).toBe(true);
  });

  it('rejects when the requested qty exceeds variant stock and no backorder is allowed', () => {
    const p = {
      inventory: 0,
      trackInventory: true,
      allowBackorder: false,
      variants: [{ inventory: 2 }],
    };
    expect(isOrderable(p, 3, enabled)).toBe(false);
  });

  it('allows a backorder only when the feature flag AND the product flag are set', () => {
    const p = {
      inventory: 0,
      trackInventory: true,
      allowBackorder: true,
      variants: [{ inventory: 0 }],
    };
    expect(isOrderable(p, 3, true)).toBe(true);
    expect(isOrderable(p, 3, false)).toBe(false);
  });

  it('allows a backorder when any variant permits it, matching enrichStockFlags', () => {
    const p = {
      inventory: 0,
      trackInventory: true,
      allowBackorder: false,
      variants: [{ inventory: 0, allowBackorder: true }],
    };
    expect(isOrderable(p, 3, true)).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/unit/effective-inventory.test.ts`
Expected: FAIL — `Failed to resolve import "@api/lib/effective-inventory"`.

- [ ] **Step 3: Write the implementation**

```ts
// apps/api/src/lib/effective-inventory.ts
/**
 * The single definition of "how much stock does this product have".
 *
 * `products.inventory` means on-hand stock ONLY for a product with no
 * variants. For a variant product the stock lives on the variants and the
 * parent column is unused (held at 0 by the invariant this module exists to
 * protect) — see `enrichStockFlags` in product.service.ts, which has always
 * documented that contract for the public serializer.
 *
 * Before this module, six call sites each dereferenced `product.inventory`
 * directly and were therefore blind to variants. Because checkout also
 * decremented the parent on every variant sale, that column had drifted
 * negative on 24 live products, and each of those readers turned the drift
 * into a permanent, un-clearable "out of stock" (see
 * docs/superpowers/plans/2026-08-30-variant-stock-drift.md). Read stock
 * through here; do not dereference `.inventory` in a new call site.
 */

export interface StockShape {
  inventory: number;
  trackInventory?: boolean;
  allowBackorder?: boolean;
  variants?: Array<{ inventory: number; allowBackorder?: boolean }> | null;
}

/**
 * Prisma `select` fragment supplying everything `effectiveInventory` and
 * `isOrderable` need. Spread it into a product select so a caller cannot
 * accidentally omit `variants` — an omitted `variants` is indistinguishable
 * from "has no variants" at runtime, which is precisely how a variant-blind
 * read looks correct in review and wrong in production.
 */
export const EFFECTIVE_STOCK_SELECT = {
  inventory: true,
  trackInventory: true,
  allowBackorder: true,
  variants: { select: { inventory: true, allowBackorder: true } },
} as const;

/** Stock for a product: the variant sum when it has variants, else its own column. */
export function effectiveInventory(product: StockShape): number {
  const variants = product.variants ?? [];
  if (variants.length === 0) return product.inventory;
  return variants.reduce((sum, v) => sum + (v.inventory ?? 0), 0);
}

/**
 * Whether `qty` of this product can be ordered. Mirrors the dual-gate the
 * order/cart paths already use: an out-of-stock line is accepted ONLY when
 * the store-level `inventory.backorder` feature AND a per-product/per-variant
 * `allowBackorder` flag are both set.
 */
export function isOrderable(
  product: StockShape,
  qty: number,
  backorderFeatureEnabled: boolean
): boolean {
  if (product.trackInventory === false) return true;
  if (effectiveInventory(product) >= qty) return true;

  const variants = product.variants ?? [];
  const allowsBackorder =
    product.allowBackorder === true || variants.some(v => v.allowBackorder === true);
  return backorderFeatureEnabled && allowsBackorder;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/unit/effective-inventory.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/lib/effective-inventory.ts tests/unit/effective-inventory.test.ts
git commit -m "feat(inventory): one shared definition of variant-aware product stock"
```

---

### Task 2: Fix `CartService.updateItem` — the reported symptom

92 live products currently reject every cart quantity change. This is the smallest change that
unblocks them, so it lands on its own commit and can ship ahead of the rest if needed.

**Files:**

- Modify: `apps/api/src/services/cart.service.ts:353-372`
- Test: `tests/unit/cart-variant-stock.test.ts`

**Interfaces:**

- Consumes: `effectiveInventory` from Task 1 (not used here — the cart line names an exact variant, so the variant row is authoritative; `effectiveInventory` is for product-scoped callers that have no variant in hand).
- Produces: no new exports.

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/cart-variant-stock.test.ts
/**
 * Regression: CartService.updateItem checked the PARENT product's inventory
 * for a variant cart line. On a variant product the parent column is not
 * stock (and had drifted negative in production), so every quantity change
 * threw INSUFFICIENT_INVENTORY no matter how much variant stock existed.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { CartService } from '@api/services/cart.service';
import { prisma } from '@ebda/database';

vi.mock('@ebda/database', () => ({
  prisma: {
    cart: { findFirst: vi.fn(), create: vi.fn(), update: vi.fn(), findUnique: vi.fn() },
    cartItem: { findFirst: vi.fn(), update: vi.fn(), delete: vi.fn() },
    product: { findFirst: vi.fn(), update: vi.fn() },
    productVariant: { findUnique: vi.fn() },
    $transaction: vi.fn(),
  },
  Prisma: { TransactionIsolationLevel: { Serializable: 'Serializable' } },
  OrderStatus: {
    pending: 'pending',
    confirmed: 'confirmed',
    processing: 'processing',
    shipped: 'shipped',
    delivered: 'delivered',
    cancelled: 'cancelled',
    refunded: 'refunded',
  },
}));

vi.mock('@api/services/feature.service', () => ({
  featureService: { isFeatureEnabled: vi.fn().mockResolvedValue(false) },
}));

const CART = { id: 'cart-1', items: [] };

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(CartService, 'getOrCreate').mockResolvedValue(CART as never);
  (prisma.cart.update as ReturnType<typeof vi.fn>).mockResolvedValue({});
  (prisma.cartItem.update as ReturnType<typeof vi.fn>).mockResolvedValue({});
});

describe('CartService.updateItem — variant lines', () => {
  it('uses the VARIANT stock, not the drifted parent column', async () => {
    // Exact production shape: parent -16, variant holds 1173.
    (prisma.cartItem.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: 'item-1',
      cartId: 'cart-1',
      productId: 'prod-1',
      variantId: 'var-1',
      product: { trackInventory: true, inventory: -16, allowBackorder: false },
      variant: { id: 'var-1', inventory: 1173, allowBackorder: false },
    });

    await expect(CartService.updateItem('store-1', 'sess-1', 'item-1', 3)).resolves.toBeDefined();
    expect(prisma.cartItem.update).toHaveBeenCalledWith({
      where: { id: 'item-1' },
      data: { quantity: 3 },
    });
  });

  it('still rejects when the VARIANT itself is short', async () => {
    (prisma.cartItem.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: 'item-1',
      cartId: 'cart-1',
      productId: 'prod-1',
      variantId: 'var-1',
      product: { trackInventory: true, inventory: 500, allowBackorder: false },
      variant: { id: 'var-1', inventory: 2, allowBackorder: false },
    });

    await expect(CartService.updateItem('store-1', 'sess-1', 'item-1', 3)).rejects.toThrow(
      /Not enough inventory/
    );
    expect(prisma.cartItem.update).not.toHaveBeenCalled();
  });

  it('leaves non-variant lines on the product column (unchanged behaviour)', async () => {
    (prisma.cartItem.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: 'item-1',
      cartId: 'cart-1',
      productId: 'prod-1',
      variantId: null,
      product: { trackInventory: true, inventory: 2, allowBackorder: false },
      variant: null,
    });

    await expect(CartService.updateItem('store-1', 'sess-1', 'item-1', 3)).rejects.toThrow(
      /Not enough inventory/
    );
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/unit/cart-variant-stock.test.ts`
Expected: the first test FAILS with `Not enough inventory` (it reads `product.inventory = -16`).
The other two pass already — keep them, they are the regression fence.

- [ ] **Step 3: Implement — include the variant, and check against it**

In `apps/api/src/services/cart.service.ts`, change the `findFirst` in `updateItem` to load the
variant alongside the product:

```ts
const item = await prisma.cartItem.findFirst({
  where: { id: itemId, cartId: cart.id },
  // The variant is REQUIRED here, not a nicety: for a variant line the
  // parent product's `inventory` column is not stock (see
  // lib/effective-inventory.ts). Selecting only `product` is what made
  // every quantity change on a variant product throw.
  include: {
    product: true,
    variant: { select: { id: true, inventory: true, allowBackorder: true } },
  },
});
```

and replace the check:

```ts
// Variant lines are authoritative on the VARIANT row; only a
// variant-less line falls back to the product column. Mirrors
// `addItem` (~:151) and `validate` (~:285), which have always done this.
const stockHolder = item.variant ?? item.product;
const effectiveAllowBackorder =
  backorderFeatureEnabled && (item.variant?.allowBackorder ?? item.product.allowBackorder);
if (item.product.trackInventory && stockHolder.inventory < quantity && !effectiveAllowBackorder) {
  throw new AppError(400, 'INSUFFICIENT_INVENTORY', 'Not enough inventory');
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/unit/cart-variant-stock.test.ts tests/unit/cart.test.ts`
Expected: PASS. `cart.test.ts` must stay green unmodified — it covers the non-variant path.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/cart.service.ts tests/unit/cart-variant-stock.test.ts
git commit -m "fix(cart): update-quantity read variant stock, not the parent column"
```

---

### Task 3: Stop the drift — one writer per row on the order paths

**Files:**

- Modify: `apps/api/src/services/inventory-decrement.ts:47-61` (delete `forceDecrementProductInventory`)
- Modify: `apps/api/src/services/order.service.ts:613-666` (sale) and `:1014-1038` (payment rollback)
- Modify: `apps/api/src/lib/inngest/functions/order-refunded.ts:113-145` (refund restore)
- Test: `tests/unit/order-variant-stock-isolation.test.ts`

**Interfaces:**

- Consumes: nothing from Task 1 (these paths hold an explicit `variantId`).
- Produces: `forceDecrementProductInventory` is **removed** from `inventory-decrement.ts`. Any later task importing it is a bug.

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/order-variant-stock-isolation.test.ts
/**
 * Invariant: one order line writes the variant row XOR the product row.
 *
 * Checkout used to decrement BOTH for a variant sale, which drove the parent
 * column of every variant product monotonically negative (24 live products,
 * to -16 at worst). The refund path incremented both, and the payment
 * rollback incremented ONLY the product — so the two directions never even
 * cancelled out.
 */
import { describe, it, expect } from 'vitest';
import * as decrement from '@api/services/inventory-decrement';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const read = (p: string) => readFileSync(resolve(__dirname, '../..', p), 'utf8');

describe('inventory-decrement module surface', () => {
  it('no longer exports an unfloored product force-decrement', () => {
    expect('forceDecrementProductInventory' in decrement).toBe(false);
  });

  it('still exports the three helpers the order path needs', () => {
    expect(typeof decrement.decrementProductInventory).toBe('function');
    expect(typeof decrement.decrementVariantInventory).toBe('function');
    expect(typeof decrement.forceDecrementVariantInventory).toBe('function');
  });
});

describe('order paths never write both rows for one line', () => {
  it('order.service.ts has no product force-decrement left', () => {
    expect(read('apps/api/src/services/order.service.ts')).not.toContain(
      'forceDecrementProductInventory'
    );
  });

  it('the refund restore guards the product increment behind "no variantId"', () => {
    const src = read('apps/api/src/lib/inngest/functions/order-refunded.ts');
    // The product increment must sit in the else-branch of the variant check.
    expect(src).toMatch(
      /if \(item\.variantId\) \{[\s\S]*?productVariant\.update[\s\S]*?\} else \{[\s\S]*?product\.update/
    );
  });

  it('the payment rollback restores the variant when the line has one', () => {
    expect(read('apps/api/src/services/order.service.ts')).toMatch(
      /rollback[\s\S]*?item\.variantId[\s\S]*?productVariant\.update/
    );
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/unit/order-variant-stock-isolation.test.ts`
Expected: FAIL on all four — the export still exists and both writes still happen.

- [ ] **Step 3a: Delete the unfloored helper**

Remove `forceDecrementProductInventory` entirely from
`apps/api/src/services/inventory-decrement.ts` (lines 47-61). It has exactly one purpose — the
parent-of-variant decrement — and that purpose is the bug. Leaving it exported invites the next
engineer to reintroduce the drift.

Update the module doc-comment's last paragraph to record why:

```ts
/**
 * … (existing text) …
 *
 * There is deliberately NO unfloored product decrement. One existed until
 * 2026-08-30 to mirror a variant sale onto the parent `products.inventory`
 * column; because a variant product's parent column starts at 0, it only ever
 * went down, and 24 live products had drifted as far as -16 while their
 * variants held four-figure stock. A line decrements the variant row or the
 * product row, never both — see lib/effective-inventory.ts.
 */
```

- [ ] **Step 3b: Sale path — the variant line stops touching the parent**

In `apps/api/src/services/order.service.ts`, replace the block at `:649-666`:

```ts
          // Backorder accepted — force the decrement + track for
          // BackorderLine creation below. Variant lines floor at 0 so the
          // admin grid never shows a negative; product lines are the
          // conditional decrement's miss path and may legitimately go to 0.
          res = variantId
            ? await forceDecrementVariantInventory(tx, variantId, qty)
            : await decrementProductInventory(tx, item.productId, qty);
          backorderedItems.push({ productId: item.productId, variantId, quantity: qty });
        }

        // ONE row per line. A variant sale moves the variant's stock and
        // nothing else — `products.inventory` is not a running total for a
        // variant product, it is unused (held at 0). Mirroring the sale onto
        // the parent is what drove that column negative across the catalogue.
        // The InventoryHistory row below is keyed on productId (the table has
        // no variantId column), so for a variant line its previous/new stock
        // describe the VARIANT's movement — which is the movement that
        // actually happened.
        stockChanges.set(lineKey, {
          previousStock: res.previousStock,
          newStock: res.newStock,
        });
      }
```

Then delete `forceDecrementProductInventory` from the import block at `:13-16`.

> Note on the backorder miss-path: the old code called the _unfloored_ product decrement here for
> a non-variant backordered line, letting `products.inventory` go negative on purpose. Keep that
> behaviour — a non-variant product's negative inventory is a real, meaningful backorder debt.
> Use `decrementProductInventory` only if it succeeds; if the line reached this branch it did not,
> so keep the unconditional form for the product case by inlining the raw update rather than
> reusing the deleted helper:
>
> ```ts
> // Non-variant backorder: the debt is real and belongs on the product row.
> const [row] = await tx.$queryRaw<Array<{ inventory: number }>>`
>   UPDATE public.products SET inventory = inventory - ${qty}
>   WHERE id = ${item.productId} RETURNING inventory`;
> res = { ok: true, previousStock: (row?.inventory ?? 0) + qty, newStock: row?.inventory ?? 0 };
> ```
>
> Use this inline form in place of `decrementProductInventory` in the snippet above.

- [ ] **Step 3c: Payment-rollback path — restore the row that was decremented**

In `apps/api/src/services/order.service.ts` at `:1014-1038`, the rollback increments the product
for **every** line, including variant lines whose product was never decremented. Replace with:

```ts
// 1. Restore inventory (mirror exactly what create() decremented:
//    the variant row for a variant line, the product row otherwise).
for (const item of order.items) {
  const product = await tx.product.findUnique({
    where: { id: item.productId },
    select: { trackInventory: true, inventory: true },
  });
  if (!product?.trackInventory) continue;

  let previousStock: number;
  if (item.variantId) {
    const restored = await tx.productVariant.update({
      where: { id: item.variantId },
      data: { inventory: { increment: item.quantity } },
      select: { inventory: true },
    });
    previousStock = restored.inventory - item.quantity;
  } else {
    await tx.product.update({
      where: { id: item.productId },
      data: { inventory: { increment: item.quantity } },
    });
    previousStock = product.inventory;
  }

  await tx.inventoryHistory.create({
    data: {
      productId: item.productId,
      storeId,
      type: 'adjustment',
      quantity: item.quantity,
      previousStock,
      newStock: previousStock + item.quantity,
      reason: 'Order rollback — payment step failed',
      reference: order.id,
    },
  });
}
```

- [ ] **Step 3d: Refund restore — same shape**

In `apps/api/src/lib/inngest/functions/order-refunded.ts`, replace `:122-131`:

```ts
if (!lockedProduct?.track_inventory) continue;

// One row per line, matching the sale. A variant refund returns
// stock to the variant only; the parent column is not a total.
let prevStock: number;
if (item.variantId) {
  const restored = await tx.productVariant.update({
    where: { id: item.variantId },
    data: { inventory: { increment: item.quantity } },
    select: { inventory: true },
  });
  prevStock = restored.inventory - item.quantity;
} else {
  prevStock = lockedProduct.inventory;
  await tx.product.update({
    where: { id: item.productId },
    data: { inventory: { increment: item.quantity } },
  });
}
```

The `SELECT … FOR UPDATE` on `products` above stays — it is the per-line serialization lock and
the `track_inventory` read, both still needed.

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/unit/order-variant-stock-isolation.test.ts tests/unit/order.test.ts tests/unit/order-refunded-reversals.test.ts`
Expected: PASS. If `order-refunded-reversals.test.ts` asserts the old double-write, update that
assertion — it encoded the bug.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/inventory-decrement.ts apps/api/src/services/order.service.ts \
        apps/api/src/lib/inngest/functions/order-refunded.ts \
        tests/unit/order-variant-stock-isolation.test.ts
git commit -m "fix(orders): a variant line writes the variant row, never the parent product"
```

---

### Task 4: Stop the drift — PO receive and the product-scoped adjusters

**Files:**

- Modify: `apps/api/src/services/accounting/purchase-order.service.ts:182-231`
- Modify: `apps/api/src/services/inventory.service.ts:297-330` (`adjustInventory`) and `:424-500` (`bulkAdjustInventory`)

**Interfaces:**

- Consumes: `effectiveInventory` from Task 1.
- Produces: `adjustInventory` / `bulkAdjustInventory` now throw `AppError(400, 'VARIANT_PRODUCT', …)` for a product with variants.

- [ ] **Step 1: PO receive — WAC from variant-aware on-hand, no parent stock write**

Receiving a variant PO line currently increments the variant **and** writes
`inventory: newStock` on the parent, so it pushes the parent column _up_ — the same drift in
reverse. The weighted-average-cost maths legitimately needs on-hand quantity, and for a variant
product that quantity is the variant sum, not the parent column.

Replace `apps/api/src/services/accounting/purchase-order.service.ts:182-231` with:

```ts
// Step 1b: Replenish on-hand with remainder + WAC recompute
if (remainingToProcess > 0) {
  const product = await tx.product.findUnique({
    where: { id: item.productId },
    select: {
      inventory: true,
      costPrice: true,
      variants: { select: { inventory: true } },
    },
  });
  if (!product) throw new Error(`Product ${item.productId} not found`);

  // On-hand BEFORE this receive. For a variant product that is the
  // variant sum — the parent column is not stock (see
  // lib/effective-inventory.ts), so using it here would compute the
  // weighted average against a meaningless quantity.
  const onHandBefore = effectiveInventory(product);

  if (item.variantId) {
    await tx.productVariant.update({
      where: { id: item.variantId },
      data: { inventory: { increment: remainingToProcess } },
    });
  }

  // WAC formula: treat negative on-hand as 0 (backorder demand was consumed
  // in the FIFO clearance phase above; only pre-existing positive stock counts).
  const oldStock = Math.max(onHandBefore, 0);
  const oldCost = product.costPrice ?? item.unitCost; // first-receive fallback
  const newStock = onHandBefore + remainingToProcess;
  const denom = oldStock + remainingToProcess;
  const newCost =
    denom > 0
      ? Math.round((oldStock * oldCost + remainingToProcess * item.unitCost) / denom)
      : item.unitCost;

  // Cost always lands on the parent (the WAC is product-level). Stock
  // lands on the parent ONLY for a variant-less line — the variant
  // increment above already moved it otherwise.
  await tx.product.update({
    where: { id: item.productId },
    data: {
      ...(item.variantId ? {} : { inventory: newStock }),
      costPrice: newCost,
      lastCostUpdateAt: new Date(),
    },
  });

  // InventoryHistory row (existing FWB pattern)
  await tx.inventoryHistory.create({
    data: {
      productId: item.productId,
      storeId: input.storeId,
      type: 'transfer_in',
      quantity: remainingToProcess,
      previousStock: onHandBefore,
      newStock,
      reason: `PO receive ${po.poNumber}`,
      reference: item.id,
    },
  });
}
```

Add the import at the top of the file:

```ts
import { effectiveInventory } from '../../lib/effective-inventory';
```

- [ ] **Step 2: `adjustInventory` — reject variant products instead of corrupting them**

`InventoryService.adjustInventory` (`:297`) has no `variantId` and writes
`products.inventory` unconditionally. For a variant product that write is meaningless and
re-corrupts the column the migration in Task 9 repairs. The admin UI already routes stock edits
for variant products through the variant-aware StockAdjustment flow
(`stock/inventory/page.tsx:493` → `/stock/adjustments/new`), so rejecting here breaks no
supported path — and failing loud beats a silent no-op.

After the `if (!product)` guard in `adjustInventory`, add:

```ts
// A variant product's stock lives on its variants; `products.inventory`
// is unused for it (see lib/effective-inventory.ts). Writing it here
// would corrupt the column without changing any real stock, so refuse
// rather than silently no-op. The variant endpoints
// (PUT/POST .../variants/:id, .../variants/bulk-inventory) and the
// StockAdjustment flow both handle variant products correctly.
const variantCount = await prisma.productVariant.count({
  where: { productId: adjustment.productId },
});
if (variantCount > 0) {
  throw new AppError(
    400,
    'VARIANT_PRODUCT',
    'This product tracks stock on its variants. Adjust the variant inventory instead.'
  );
}
```

- [ ] **Step 3: `bulkAdjustInventory` — same guard, per row**

`bulkAdjustInventory` validates every row in memory before one transaction, and marks bad rows
failed without aborting the batch. Extend the existing `findMany` that loads candidate products
to include `variants: { select: { id: true }, take: 1 }`, then in the per-row validation loop —
alongside the existing out-of-store / not-found / negative-stock checks — add:

```ts
if (product.variants.length > 0) {
  failed++;
  errors.push(
    `${product.name}: tracks stock on its variants — adjust the variant inventory instead`
  );
  continue;
}
```

- [ ] **Step 4: Typecheck and run the affected suites**

Run: `npx tsc -p apps/api/tsconfig.json --noEmit && npx vitest run tests/unit/purchase-order-service-tenant-scoping.test.ts`
Expected: clean typecheck, PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/accounting/purchase-order.service.ts apps/api/src/services/inventory.service.ts
git commit -m "fix(inventory): PO receive and product-scoped adjust stop writing variant parents"
```

---

### Task 5: Variant-aware readers — search filter, WhatsApp bridge, payment links

**Files:**

- Modify: `apps/api/src/services/product.service.ts:1881-1884`
- Modify: `apps/api/src/routes/wa-bridge.routes.ts:198, 271, 631, 771-795`
- Modify: `apps/api/src/routes/payment-links.routes.ts:160-197`

**Interfaces:**

- Consumes: `effectiveInventory`, `isOrderable`, `EFFECTIVE_STOCK_SELECT` from Task 1.
- Produces: no new exports.

- [ ] **Step 1: `advancedSearch` — the `inStock` filter**

`where.inventory = { gt: 0 }` excludes every variant product, permanently. Postgres can express
the variant-aware condition through the relation filter, so this stays a single query:

```ts
// In stock filter — variant-aware. A variant product's stock lives on its
// variants and its own `inventory` column is unused, so filtering on that
// column alone excluded every variant product from in-stock results.
if (inStock === true) {
  where.OR = [
    ...(where.OR || []),
    { trackInventory: false },
    // No variants: the product column is the stock.
    { variants: { none: {} }, inventory: { gt: 0 } },
    // Has variants: at least one of them carries stock.
    { variants: { some: { inventory: { gt: 0 } } } },
  ];
}
```

- [ ] **Step 2: WhatsApp bridge — three catalog flags**

At `:198`, `:271` and `:631` the flag is
`inStock: !p.trackInventory || p.inventory > 0 || p.allowBackorder`. Each of the three product
queries feeding them must add `variants: { select: { inventory: true, allowBackorder: true } }`
to its `select`, and the flag becomes:

```ts
        inStock: !p.trackInventory || effectiveInventory(p) > 0 || p.allowBackorder,
```

At `:631` the response already serialises variants at `:638`; reuse that same selection rather
than adding a second one.

- [ ] **Step 3: WhatsApp bridge — the order stock check at `:771-795`**

```ts
const oos = items
  .map(i => ({ item: i, product: byId.get(i.productId)! }))
  // A WhatsApp order line names a product, not a variant, so the
  // available quantity is the product's effective stock — the variant
  // sum when it has variants (see lib/effective-inventory.ts).
  .filter(({ item, product }) => !isOrderable(product, item.quantity, backorderFeatureEnabled));
if (oos.length > 0) {
  res.status(409).json({
    success: false,
    error: 'INSUFFICIENT_INVENTORY',
    outOfStock: oos.map(({ item, product }) => ({
      productId: item.productId,
      requested: item.quantity,
      available: effectiveInventory(product),
      name: product.name,
    })),
  });
  return;
}
```

The product `findMany` feeding `byId` must spread `EFFECTIVE_STOCK_SELECT` into its `select`
(keeping `name` and any other fields it already selects).

- [ ] **Step 4: Payment links — the stock check at `:190`**

Spread `EFFECTIVE_STOCK_SELECT` into the `select` at `:169-176` (it already selects
`inventory`, `trackInventory`, `allowBackorder`; add the `variants` sub-select), then:

```ts
// Variant-aware: a payment-link line names a product, so its
// available stock is the variant sum when it has variants.
if (!isOrderable(p, it.quantity, backorderFeatureEnabled)) {
  res.status(400).json({
    success: false,
    error: 'OUT_OF_STOCK',
    message: `Product ${it.productId} has insufficient stock.`,
  });
  return;
}
```

`payment-links.routes.ts` does not currently resolve the backorder feature flag. Resolve it once
before the loop, matching `wa-bridge.routes.ts:771-774`:

```ts
const backorderFeatureEnabled = await featureService.isFeatureEnabled(
  storeId,
  'inventory.backorder'
);
```

> Behaviour change to flag in the PR: this route previously honoured only the per-product
> `allowBackorder` flag and ignored the store feature flag, unlike every other checkout surface.
> It now uses the same dual gate.

- [ ] **Step 5: Typecheck, lint, commit**

Run: `npx tsc -p apps/api/tsconfig.json --noEmit && npx eslint apps/api/src/routes/wa-bridge.routes.ts apps/api/src/routes/payment-links.routes.ts apps/api/src/services/product.service.ts`

```bash
git add apps/api/src/services/product.service.ts apps/api/src/routes/wa-bridge.routes.ts apps/api/src/routes/payment-links.routes.ts
git commit -m "fix(catalog): search filter, WhatsApp bridge and payment links read variant stock"
```

---

### Task 6: Variant-aware scans — low stock and dead stock

Both scans are scheduled Inngest jobs, so their failure mode is silence: a variant product with
a negative parent column can never satisfy `inventory > 0 && <= threshold`, so **no variant
product has ever produced a low-stock alert**.

**Files:**

- Modify: `apps/api/src/services/inventory/low-stock-scan.service.ts:148-166, 196-226`
- Modify: `apps/api/src/services/accounting/deadstock-scan.service.ts:186-222`

**Interfaces:**

- Consumes: `effectiveInventory` from Task 1.

- [ ] **Step 1: Low-stock scan**

Add `variants: { select: { inventory: true } }` to the `select` in the `findMany` at `:158-165`,
then at `:198`:

```ts
// Variant-aware: for a variant product the on-hand quantity is the
// variant sum. Reading `product.inventory` here meant a variant product
// (whose parent column is 0, and had drifted negative) never satisfied
// `> 0` and so never alerted — a silent gap, not a visible failure.
const onHand = effectiveInventory(product);
const isLow = onHand > 0 && onHand <= threshold;
```

and at `:222` report `inventory: onHand`. Hoist `onHand` above the `if (!isLow)` branch so both
uses share it.

- [ ] **Step 2: Dead-stock scan**

Add `variants: { select: { inventory: true } }` to the `select` at `:187-193`, then at `:211`:

```ts
// Variant-aware on-hand — `product.inventory` is not stock for a
// variant product, so valuing against it reported 0 (or a negative)
// stock-on-hand for the entire variant catalogue.
const onHand = effectiveInventory(product);
const stockValueFils = Math.round(onHand * (product.costPrice ?? 0));
```

and at `:220` report `stockOnHand: onHand`.

- [ ] **Step 3: Typecheck and commit**

Run: `npx tsc -p apps/api/tsconfig.json --noEmit`

```bash
git add apps/api/src/services/inventory/low-stock-scan.service.ts apps/api/src/services/accounting/deadstock-scan.service.ts
git commit -m "fix(scans): low-stock and dead-stock evaluate variant-aware on-hand"
```

---

### Task 7: Variant writes must bust the storefront cache

`apps/api/src/services/variant.service.ts` is 752 lines of variant CRUD — including
`bulkUpdateInventory` — and contains **zero** cache invalidation, while
`apps/api/src/lib/public-cache.ts` states that any write changing price or stock MUST call
`invalidateStoreProductCaches`. This is the second half of "I updated the variant and nothing
changed": even after Tasks 2-6, the storefront would serve a stale card for up to the TTL.

**Files:**

- Modify: `apps/api/src/services/variant.service.ts`
- Test: `tests/unit/variant-cache-invalidation.test.ts`

**Interfaces:**

- Consumes: `invalidateStoreProductCaches` from `apps/api/src/lib/public-cache.ts`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/variant-cache-invalidation.test.ts
/**
 * public-cache.ts: "ANY write that changes a product's price or stock MUST
 * call invalidateStoreProductCaches". Variant writes change stock. Until
 * 2026-08-30 variant.service.ts called it exactly zero times, so a merchant
 * restocking a variant saw no change on the storefront until the TTL lapsed.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const src = readFileSync(
  resolve(__dirname, '../../apps/api/src/services/variant.service.ts'),
  'utf8'
);

const MUTATORS = [
  'createVariant',
  'updateVariant',
  'deleteVariant',
  'generateVariants',
  'bulkUpdateInventory',
];

describe('variant.service cache invalidation', () => {
  it('imports the shared product-cache invalidator', () => {
    expect(src).toContain('invalidateStoreProductCaches');
  });

  it.each(MUTATORS)('%s busts the store product caches', name => {
    // Slice from this method's declaration to the next `static ` at the same
    // depth, and assert the invalidation happens inside it.
    const start = src.indexOf(`static async ${name}(`);
    expect(start, `${name} not found`).toBeGreaterThan(-1);
    const next = src.indexOf('\n  static ', start + 1);
    const body = src.slice(start, next === -1 ? undefined : next);
    expect(body).toContain('invalidateStoreProductCaches');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/unit/variant-cache-invalidation.test.ts`
Expected: FAIL, 6 failures (the import plus all five mutators).

- [ ] **Step 3: Add the invalidation**

Add the import at the top of `variant.service.ts`:

```ts
import { invalidateStoreProductCaches } from '../lib/public-cache';
```

Then, at the end of each of `createVariant`, `updateVariant`, `deleteVariant`,
`generateVariants` and `bulkUpdateInventory` — after the write commits and before the return —
add:

```ts
// Variant stock/price is serialised into the storefront product list,
// detail and suggest caches (public-cache.ts). Without this the merchant
// restocks a variant and the storefront keeps serving "Sold Out" until
// the TTL lapses.
await invalidateStoreProductCaches(storeId);
```

Where a method returns the result of an expression directly, hoist it into a `const` first so the
invalidation runs before the return.

`reorderVariants` also mutates variants, but only `position`, which no cached payload orders on;
leave it, and say so in a one-line comment so the omission reads as deliberate.

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/unit/variant-cache-invalidation.test.ts && npx tsc -p apps/api/tsconfig.json --noEmit`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/variant.service.ts tests/unit/variant-cache-invalidation.test.ts
git commit -m "fix(variants): bust storefront product caches on every variant write"
```

---

### Task 8: Admin product detail shows variant-aware stock

**Files:**

- Modify: `apps/admin/src/app/stores/[id]/products/[productId]/_components/ProductInfoSections.tsx:130-145`

This is the surface that displays `-16`. Two defects: it reads the raw parent column, and its
red "out of stock" state is `=== 0`, so a negative renders as amber "low stock". The admin
product **list** already does this correctly (`ProductsTable.tsx:216`) — match it.

- [ ] **Step 1: Read the list's resolution and mirror it**

`ProductsTable.tsx:216` resolves `product.hasVariants ? (product.totalInventory ?? 0) : product.inventory`.
The product-detail API payload carries `hasVariants` and the variant rows, so resolve from the
variants directly:

```tsx
<div>
  <label className="text-sm font-medium text-muted-foreground">{tFields('stock')}</label>
  {(() => {
    // Variant products carry their stock on the variants; the
    // product-level `inventory` column is unused for them. Mirrors
    // ProductsTable.tsx (~:216) and the API's enrichStockFlags.
    const onHand = product.hasVariants
      ? (product.variants ?? []).reduce((sum, v) => sum + (v.inventory ?? 0), 0)
      : product.inventory;
    return (
      <p
        className={`mt-1 text-lg font-semibold ${
          onHand <= 0
            ? 'text-destructive'
            : onHand <= product.lowStockThreshold
              ? 'text-warning'
              : 'text-[hsl(var(--success))]'
        }`}
      >
        {tFields('stockInStock', { count: onHand })}
      </p>
    );
  })()}
</div>
```

Note `onHand <= 0`, not `=== 0`: a non-variant product can hold a legitimate negative
(backorder debt) and that must read as out-of-stock, not as low-stock amber.

- [ ] **Step 2: Confirm the type carries `variants`**

Check the `product` prop's type in this component. If `variants` is absent, add
`variants?: Array<{ inventory: number }>` to it and confirm the page's fetch selects them; the
admin product-detail endpoint returns raw Prisma rows including variants.

- [ ] **Step 3: Typecheck**

Run: `npx tsc -p apps/admin/tsconfig.json --noEmit`

- [ ] **Step 4: Commit**

```bash
git add "apps/admin/src/app/stores/[id]/products/[productId]/_components/ProductInfoSections.tsx"
git commit -m "fix(admin): product detail shows variant-aware stock and flags <=0 as out of stock"
```

---

### Task 9: Repair the corrupted rows

Runs **last**: every reader must already be variant-aware before the parent column is zeroed,
otherwise a reader missed by Tasks 5-6 would flip from "wrong because negative" to "wrong
because zero".

**Files:**

- Create: `packages/database/prisma/migrations/20260830090000_zero_variant_parent_inventory/migration.sql`

- [ ] **Step 1: Write the migration**

```sql
-- Repair: `products.inventory` is on-hand stock ONLY for a product with no
-- variants. For a variant product the stock lives on `product_variants` and
-- the parent column is unused.
--
-- Until 2026-08-30 checkout mirrored every variant sale onto the parent with
-- an unfloored decrement, and PO-receive mirrored every variant receipt onto
-- it. Because a variant product's parent column starts at 0, it drifted:
-- of 191 variant products, 63 hold a non-zero parent (the rows this
-- statement resets) and 24 of those had gone negative — as far as -16
-- against variants holding 1173. Eleven read paths then turned that drift
-- into a permanent "out of stock" that no variant edit could clear.
--
-- Verified by dry-run inside a rolled-back transaction on 2026-08-30:
-- 63 rows updated, 0 variant products left non-zero, and all 285 non-variant
-- rows (whose `inventory` IS their real stock) untouched.
--
-- The writers are fixed in this same release (see
-- docs/superpowers/plans/2026-08-30-variant-stock-drift.md), so this reset is
-- one-shot, not recurring. Zero — not the variant sum — is deliberate: a
-- snapshot of the sum would be a number nothing maintains, and the next
-- variant-blind reader would silently consume a stale value instead of
-- failing visibly.
UPDATE public.products p
SET inventory = 0
WHERE p.inventory <> 0
  AND EXISTS (SELECT 1 FROM public.product_variants v WHERE v.product_id = p.id);
```

- [ ] **Step 2: Dry-run the row count against a copy, not production**

Run the statement inside a transaction and roll it back — safe on the live
database, and it proves the SQL as written rather than a paraphrase of it:

```bash
psql "$DATABASE_URL" <<'SQL'
BEGIN;
\i packages/database/prisma/migrations/20260830090000_zero_variant_parent_inventory/migration.sql
SELECT count(*) AS must_be_zero FROM products p
WHERE p.inventory <> 0 AND EXISTS (SELECT 1 FROM product_variants v WHERE v.product_id = p.id);
SELECT count(*) AS non_variant_untouched FROM products p
WHERE p.inventory <> 0 AND NOT EXISTS (SELECT 1 FROM product_variants v WHERE v.product_id = p.id);
ROLLBACK;
SQL
```

Expected (measured 2026-08-30): `UPDATE 63`, `must_be_zero = 0`,
`non_variant_untouched = 285`.

Note the two distinct counts, which are easy to conflate: **166** variant
products disagree with their variant sum (the drift measure quoted in "Root
cause"), while **63** hold a non-zero parent — only those are rows this
statement changes. The other 128 variant products are already at 0.

- [ ] **Step 3: Apply and verify the invariant holds**

```bash
npx prisma migrate deploy --schema packages/database/prisma/schema.prisma
psql "$DATABASE_URL" -c "
SELECT count(*) AS must_be_zero FROM products p
WHERE p.inventory <> 0
  AND EXISTS (SELECT 1 FROM product_variants v WHERE v.product_id = p.id);"
```

Expected: `must_be_zero = 0`.

- [ ] **Step 4: Commit**

```bash
git add packages/database/prisma/migrations/20260830090000_zero_variant_parent_inventory
git commit -m "fix(db): zero the parent inventory column on variant products"
```

---

### Task 10: Full verification + docs

- [ ] **Step 1: Whole-repo gates**

```bash
npx tsc -p apps/api/tsconfig.json --noEmit
npx tsc -p apps/admin/tsconfig.json --noEmit
npx vitest run
npx eslint apps/api/src apps/admin/src
```

All must pass. A pre-existing failure unrelated to stock is reported, not silently accepted.

- [ ] **Step 2: Re-run the production diagnostic**

```bash
psql "$DATABASE_URL" -c "
SELECT count(*) FILTER (WHERE p.inventory < 0)                          AS negative,
       count(*) FILTER (WHERE vs.n > 0 AND p.inventory <> 0)            AS variant_parents_nonzero,
       count(*) FILTER (WHERE p.track_inventory AND NOT p.allow_backorder
                          AND p.inventory < 1 AND vs.total > 0)         AS cart_update_would_fail
FROM products p
JOIN LATERAL (SELECT count(*) n, coalesce(sum(v.inventory),0) total
              FROM product_variants v WHERE v.product_id=p.id) vs ON TRUE
WHERE p.deleted_at IS NULL AND p.status='active';"
```

Expected: `negative = 0`, `variant_parents_nonzero = 0`. `cart_update_would_fail` is now a
meaningless label — the count may stay non-zero, but Task 2 means it no longer predicts a
failure. Confirm behaviourally instead: change the quantity of a variant line in a pecannbee
cart and get a 200.

- [ ] **Step 3: Documentation parity**

Update, in this same commit:

- `docs/architecture/` — whichever inventory/data-model doc describes `products.inventory`; state the invariant.
- `docs/audits/` — add a short entry recording the 24/166/92 production counts and the fix, so the numbers survive.
- `ROADMAP.md` / `FIXES.md` if either lists an open stock defect.

- [ ] **Step 4: Blast-radius sweep**

One consolidated grep over every identifier this change touched, across code, tests, configs and
docs; record the result in the PR body:

```bash
grep -rn "forceDecrementProductInventory" --include="*.ts" --include="*.md" . | grep -v node_modules
grep -rn "\.inventory\b" --include="*.ts" --include="*.tsx" apps packages | grep -v node_modules | grep -v "\.test\."
```

Every remaining `.inventory` read must be either a variant row, a non-variant-product path, or
routed through `effectiveInventory`. Anything else is a missed sibling.

- [ ] **Step 5: Commit and open the PR**

```bash
git add docs ROADMAP.md FIXES.md
git commit -m "docs: record the variant stock-drift invariant and the production counts"
git push -u origin fix/variant-stock-drift
```

---

## Self-Review

**Spec coverage.** Every surface named in the diagnosis has a task: the write-side drift
(Tasks 3, 4), the six variant-blind readers — cart (2), search filter (5), WhatsApp ×4 (5),
payment links (5), low stock (6), dead stock (6), admin PDP (8) — the missing cache invalidation
(7), and the data repair (9). The rollback/refund asymmetry found during investigation is in
Task 3. `postAdjustment` needs no change; it is the reference implementation.

**Placeholders.** None: every code step carries the literal code, every test step the literal
test, every verification step the literal command and its expected output.

**Type consistency.** `effectiveInventory`, `isOrderable`, `EFFECTIVE_STOCK_SELECT` and
`StockShape` are defined once in Task 1 and used with those exact names in Tasks 4, 5 and 6.
`forceDecrementProductInventory` is deleted in Task 3 and imported by no later task.

**Sequencing constraint.** Task 9 must run after Tasks 5 and 6, for the reason stated in its
preamble. Tasks 2 and 9 together are the minimum that unblocks the merchant, and Task 2 is
independently shippable.
