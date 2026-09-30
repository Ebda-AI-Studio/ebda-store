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

**A disabled variant is not stock** (owner decision 2026-09-25, #1103). "Its
stock" above means the sum over variants with `is_active = true`; a variant
with `is_active = false` counts for nothing — not on the storefront, not in the
admin list or detail, not to the WhatsApp bot, not in low-stock / dead-stock
scans, not in finance valuation or the PO weighted-average cost. A product
whose variants are ALL disabled has stock `0`, never its parent column.
Checkout can never sell a disabled variant, so counting one only produced a
product that read "in stock" on units nobody could buy — and, before this rule,
two different totals for the same product depending on which screen you asked.

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
the columns by hand. It selects every variant WITH its `isActive` flag and lets
the helper drop the disabled ones; a hand-written select must do the same
(`variants: { select: { inventory: true, isActive: true } }`). A select that
pre-filters with `where: { isActive: true }` is safe for display but, for a
product whose variants are all disabled, reads as variant-less and falls back
to the parent column — which the invariant holds at `0`. An omitted `variants` is indistinguishable at runtime
from "this product has no variants", which is exactly how a variant-blind read
passes review and fails in production.

**A filter must agree with its computation.** A query that computes
variant-aware stock but still says `where: { inventory: { gt: 0 } }` has
already excluded every variant product before the computation runs. In Prisma,
express it as relation filters:

```ts
OR: [
  { variants: { none: {} }, inventory: { gt: 0 } }, // no variants → own column
  { variants: { some: { isActive: true, inventory: { gt: 0 } } } }, // any ACTIVE in stock
];
```

`tests/unit/effective-inventory.test.ts` fails on a stock-only variant select
without `isActive` and on a `some: { inventory … }` filter without it.

The public storefront is a special case that needs no helper:
`enrichStockFlags` (`product.service.ts`) already overwrites the serialized
`inventory` with the variant-aware aggregate (active variants only, and a
disabled variant's own `inStock` is `false`), so every `apps/web` surface
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
- **Cost follows the row that holds the stock** (2026-09-30). A PO receive for
  a variant line writes the weighted average cost to the VARIANT, averaged over
  that variant's own on-hand; a variant-less line writes it to the product.
  The parent's `costPrice` on a variant product is only the fallback for a
  variant with no cost of its own — see `purchase-order.service.ts`.
- **Reading cost** uses the same rule everywhere: `variant.costPrice ??
product.costPrice`. Order lines snapshot it at sale time
  (`lib/order-line-cost.ts` — checkout, bundle components, admin manual
  orders), and stock VALUE in SQL uses `STOCK_VALUE_SQL`
  (`lib/effective-inventory-sql.ts`: active variants only, each at its own
  cost) — the finance dashboard, the analytics inventory snapshot and the
  inventory page. `null` cost means unknown, never 0.
- **A product-scoped write aimed at a variant product must fail loud.**
  `InventoryService.adjustInventory` / `bulkAdjustInventory` return a 400
  (`VARIANT_PRODUCT`) rather than writing a column that moves no stock. The
  CSV stock-adjustment import (`POST …/stock-adjustments/csv-import`) rejects
  such a row with a per-row error pointing at the variant SKU (2026-09-25).
  Known gap, not yet closed: the manual stock-adjustment form and the
  cycle-count reconcile still send product-level lines without a `variantId`.
- **A non-variant product may legitimately go negative** — that is real
  backorder debt. Only variant rows are floored at 0.

## Cancelling one backorder line

`cancelBackorder` (`POST …/backorders/:id/cancel`) takes back only that
line's unfulfilled units (`qty − qtyFulfilled`) — owner decision 2026-09-30,
ruling AP-5 in `docs/RULINGS.md`. In one `withMoneyTx` it claims the line
(conditional on `cancelledAt: null`, so a second cancel is a 404) and writes a
`backorder_line_cancelled` orderEvent recording those units. After commit it
fires the ITEM-LEVEL `order/refunded` event (`partial`, refundKey
`backorder:<lineId>`, `restoreInventory: false`):

- the GL posts a pro-rata adjustment for that line through the partial-return
  path (`postPartialReturnJournal`): revenue net of its discount share, its
  VAT share, its COGS. The sale entry itself stays posted. Shipping is not
  reversed; a whole-order cancel still reverses the whole sale and backs these
  adjustments out first.
- no stock moves (none was reserved for a backordered unit), and coupon,
  affiliate, loyalty and wallet stay as they are — the order is still live.
  The item's other open backorder lines stay open.

Every later item-level allocation — the GL, a return's provider refund, its
store credit — counts those units as already taken back
(`loadPriorReversedQty`, `accounting/posting/prior-reversed-qty.ts`), and
`ReturnService.create` does not let them be returned.

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
