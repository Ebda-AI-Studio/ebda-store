# Inventory model — where a product's stock actually lives

> One rule, one page. Read this before writing any code that reads or writes
> stock. Added 2026-08-30 after a defect class in which eleven call sites each
> re-derived "how much stock is there" and eight of them got it wrong.

## The invariant

> **`products.inventory` is on-hand stock ONLY for a product with no variants.
> For a product with one or more `ProductVariant` rows it is not stock, it is
> unused, and it MUST remain `0`. That product's stock is
> `SUM(product_variants.inventory)`.**

There is no third case. A variant product's parent column is not a cached
total, not a running counter, and not a fallback.

## Reading stock

Never dereference `product.inventory` to answer "is this available" or "how
many are there". Use the shared helpers:

| Need                                                | Use                                         | Module                                        |
| --------------------------------------------------- | ------------------------------------------- | --------------------------------------------- |
| Quantity in JS                                      | `effectiveInventory(product)`               | `apps/api/src/lib/effective-inventory.ts`     |
| "Can N be ordered?" (incl. the backorder dual-gate) | `isOrderable(product, qty, featureEnabled)` | same                                          |
| The Prisma `select` that feeds them                 | `EFFECTIVE_STOCK_SELECT`                    | same                                          |
| Filter / sort / aggregate on stock in SQL           | `ON_HAND_SQL`                               | `apps/api/src/lib/effective-inventory-sql.ts` |

Two modules on purpose: the TS helper is imported by cart, orders and several
routes, so it stays free of any `@force/database` import — otherwise every one
of their unit-test mocks has to stub `Prisma.sql`.

Spread `EFFECTIVE_STOCK_SELECT` into a product `select` rather than listing
the columns by hand. An omitted `variants` is indistinguishable at runtime
from "this product has no variants", which is exactly how a variant-blind read
passes review and fails in production.

**A filter must agree with its computation.** A query that computes
variant-aware stock but still says `where: { inventory: { gt: 0 } }` has
already excluded every variant product before the computation runs. In Prisma,
express it as relation filters:

```ts
OR: [
  { variants: { none: {} }, inventory: { gt: 0 } }, // no variants → own column
  { variants: { some: { inventory: { gt: 0 } } } }, // has variants → any in stock
];
```

The public storefront is a special case that needs no helper:
`enrichStockFlags` (`product.service.ts`) already overwrites the serialized
`inventory` with the variant-aware aggregate, so every `apps/web` surface
reading `p.inventory` is correct as-is.

## Writing stock

**One line writes the variant row XOR the product row — never both.** The
reference implementation is `postAdjustment` in
`apps/api/src/services/accounting/stock-adjustment.service.ts`:

```ts
if (item.variantId) {
  await tx.productVariant.update({
    where: { id: item.variantId },
    data: { inventory: item.newQty },
  });
} else {
  await tx.product.update({ where: { id: item.productId }, data: { inventory: item.newQty } });
}
```

Every stock writer follows this shape: checkout, refund restore, the
payment-failure rollback, PO receive, stock adjustments.

Consequences worth stating explicitly:

- **`InventoryHistory` has no `variantId`** (it is keyed on `productId`). For a
  variant line its `previousStock`/`newStock` therefore describe the
  **variant's** movement. That is the movement that actually happened; do not
  reach for the parent column to make the ledger "product-level".
- **Weighted average cost is product-level** and still lands on the parent, but
  its on-hand term must be variant-aware — see `purchase-order.service.ts`.
- **A product-scoped write aimed at a variant product must fail loud.**
  `InventoryService.adjustInventory` / `bulkAdjustInventory` return a 400
  (`VARIANT_PRODUCT`) rather than writing a column that moves no stock.
- **A non-variant product may legitimately go negative** — that is real
  backorder debt. Only variant rows are floored at 0.

## Cache

Variant stock is serialized into the storefront product list, detail and
suggest caches. Per `apps/api/src/lib/public-cache.ts`, **any** write that
changes price or stock must call `invalidateStoreProductCaches(storeId)` —
variant writes included. `variant.service.ts` does this in every mutator
except `reorderVariants` (position only), which says so in a comment.

## Why this page exists

Until 2026-08-30, checkout decremented the parent product on every variant
sale through an unfloored helper, and PO receive incremented it on every
variant receipt. A variant product's parent column starts at 0, so it drifted:
24 live products had reached −16 while their variants held four-figure stock.

Eleven read paths then consumed that drift. Measured on the `pecannbee`
production store before the fix:

| Surface               | Reported                                                   | Reality           |
| --------------------- | ---------------------------------------------------------- | ----------------- |
| Cart quantity change  | hard-failed `INSUFFICIENT_INVENTORY` on 92 active products | variants in stock |
| Inventory dashboard   | 168 of 204 products out of stock                           | 41                |
| Total stock on hand   | 33,268 units                                               | 270,883           |
| Low Stock Alerts card | 134 products low                                           | 41                |
| Low-stock email scan  | no variant product had **ever** alerted                    | —                 |

The merchant-visible symptom was "the item stays out of stock even after I
update the variant" — because every one of those surfaces was reading a number
no variant edit could change.

Full diagnosis and fix:
`docs/superpowers/plans/2026-08-30-variant-stock-drift.md`.
Repair migration: `20260830090000_zero_variant_parent_inventory`.
