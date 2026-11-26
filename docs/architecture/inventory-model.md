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

Disabling a variant that holds units therefore changes stock and stock value
with no quantity moving. So that the drop is never silent (issue 2146): the
flip writes a zero-quantity `adjustment` row in `inventory_history`
(`reference = variant:<id>`, reason "Variant disabled — N unit(s) no longer
count as stock", and the mirror row on re-enable), and the finance dashboard
shows the value held on disabled variants on its own line under Stock Value
(`DISABLED_VARIANT_STOCK_VALUE_SQL`, the exact inverse predicate of
`STOCK_VALUE_SQL`). No journal entry is posted — see Ruling CL-14.

**Stock VALUE follows the same rule, and the ledger does not** (owner decision
2026-10-01, #2078). A disabled variant that still holds units is excluded from
every stock-value reader — the finance dashboard and the analytics inventory
snapshot (one query, `storeStockValueFils` in `lib/effective-inventory-sql.ts`),
the inventory page (`STOCK_VALUE_SQL`) and dead stock (`deadStockValueFils`) —
and disabling it posts **no** journal entry. So the dashboard's stock value and
the balance sheet's Inventory (1200) differ, by design, by the cost of the units
held on disabled variants; re-enabling the variant brings them back into the
value. Pinned by `tests/integration/accounting/owner-money-decisions.test.ts`.

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
routes, so it stays free of any `@ebda/database` import — otherwise every one
of their unit-test mocks has to stub `Prisma.sql`.

Spread `EFFECTIVE_STOCK_SELECT` into a product `select` rather than listing
the columns by hand. It selects every variant WITH its `isActive` flag and lets
the helper drop the disabled ones; a hand-written select must do the same
(`variants: { select: { inventory: true, isActive: true } }`). A select that
pre-filters with `where: { isActive: true }` must NEVER feed a stock
computation: for a product whose variants are all disabled it reads as
variant-less and falls back to the parent column — and that column is NOT
reliably `0` (converting a stocked simple product to variants leaves it as it
was). The PDP and the WhatsApp bridge did exactly this (issue 2147); they now
select every variant with `isActive` and drop the disabled ones for display
AFTER the stock is computed. `tests/unit/effective-inventory.test.ts` fails on
a pre-filtered variants relation in any file that calls `effectiveInventory`,
`isOrderable` or `enrichStockFlags`. An omitted `variants` is indistinguishable at runtime
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
Whether something can be BOUGHT (stock OR backorder) is one more rule on top of
those flags, and the storefront has exactly one copy of it:
`apps/web/src/lib/can-buy-now.ts` (`canBuyNow` / `inStockNow`), read by the
variant pills, the PDP buttons, every card path, the delivery line and JSON-LD
availability (X-02; `tests/unit/can-buy-now.test.tsx` bans a second copy).

**Backorder has one server rule too** (X-02 fix round): `lineAllowsBackorder(product,
variant, featureOn)` in `apps/api/src/lib/effective-inventory.ts` = the store's
`inventory.backorder` feature AND (the variant's flag OR the product's flag). A variant
INHERITS the product flag (the merchant bulk toggle sets only the product flag; the
variant column defaults to false). Cart add, guest→login sync, quantity change and the
checkout decrement all call it; `enrichStockFlags` shows the shopper the same inheritance,
and the public routes apply the feature AFTER the cache read with `gateBackorderPayload`
(listing, PDP, recommendations, wishlists, AI feed). Untracked stock
(`trackInventory: false`) reads `inStock: true` in the payload, as `isOrderable` and the
cart already treated it. Proof over HTTP as `ebda_app`:
`tests/integration/backorder-variant-inherits.test.ts`.
The gate walks only plain objects and arrays (a `Date`, `Decimal` or `Buffer` is passed
through untouched) and copies only what it changes. Staleness (Ruling FU46-W1b-6): the
public listing/PDP edge copy (60s + 300s stale) and the AI feed's edge window can show the
pre-change backorder state after the feature flips, as can the storefront's PDP data
cache (`revalidate: 60`, tag `products:<store>`, which a feature flip does not purge); BOUNDED-stale, because the cart and
checkout re-read the feature and decide.

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
payment-failure rollback, PO receive, stock adjustments, the backorder-line
cancel's debt heal.

**A snapshot never overwrites live stock** (INV-AUDIT-1). A stock adjustment draft and a cycle-count line
carry a quantity captured earlier; on the StoreDO, posting applies the DELTA (`delta_qty`; for a count line the
variance counted - system-at-scan) to the live row inside the single-writer section and writes the ledger row from
the live before/after. A post that would take live stock below zero is refused with 409 `STALE_SNAPSHOT` and the
draft stays open.

**Every stock write has a movement row** (INV-AUDIT-3). On the StoreDO each function that changes a stock quantity
(grid, warehouse set, bulk edit, opening stock, CSV import, gold variants, adjustments, sales, restocks) writes an
`inventory_history` row with reason and actor in the same section; unchanged values write none. The actor is the caller's
`userId` or the request scope's user. `packages/repo/test/stock-movement-guard.test.ts` discovers stock writers from the
source and fails when a new one has no movement row.

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
- **A disabled variant cannot be ordered or received into** (issue 2145). A
  PO line naming one is refused at draft time and again at receive time
  (409 `VARIANT_INACTIVE`) — its units would otherwise book AP and cost for
  stock every surface reads as 0. The merchant re-enables the variant first.
  An admin manual order naming one is refused the same way (409
  `VARIANT_INACTIVE`, `createAdminOrder`); checkout, the cart and payment
  links already sold only active variants.
  A reorder suggestion for a variant drafts its PO at the variant's cost.
  (Formerly a known gap — product-level suggestions for a VARIANT product
  drafted POs with no variant to receive into. Resolved 2026-10-01: the scan
  now suggests per variant; see the purchase-order bullet below.)
- **Reading cost** uses the same rule everywhere: `variant.costPrice ??
product.costPrice`. Order lines snapshot it at sale time
  (`lib/order-line-cost.ts` — checkout, bundle components, admin manual
  orders), and stock VALUE in SQL uses `STOCK_VALUE_SQL`
  (`lib/effective-inventory-sql.ts`: active variants only, each at its own
  cost) — the finance dashboard, the analytics inventory snapshot and the
  inventory page. `null` cost means unknown, never 0.
- **A purchase-order line names the row that holds the stock** (owner
  decision 2026-10-01). A line for a variant product must carry a
  `variantId` that belongs to that product — `createPurchaseOrder` refuses
  anything else with a 400 (`VARIANT_REQUIRED` / `VARIANT_PRODUCT_MISMATCH`),
  and `receivePurchaseOrder` refuses an old-shape variant-less line on a
  variant product (`VARIANT_REQUIRED`) instead of writing the parent column.
  The reorder scan works in the same units: one suggestion per ACTIVE variant
  of a variant product, one per product with no variants, deduped on
  (store, product, variant); drafting from one carries the variant and its
  cost. Legacy product-level suggestions for variant products, and open ones
  for since-disabled variants, are expired by the scan's own next run
  (`reorder-scan.service.ts`, step 1b). The per-unit metrics (sales, on
  order, backlog) are per variant; the last-PO supplier and its lead time are
  product-level and looked up once per product per scan (issue 2344).
  **Velocity is demand, not revenue** (INV-AUDIT-4): the 7/28-day sales count every
  order that is not `cancelled`/`refunded` whatever its payment status (a COD
  order stays `unpaid` until delivery settles it), net of units taken back by
  COMPLETED returns (`sumOrderQty`). Revenue definitions are unchanged.
- **Reorder rules have one writer** (M-107). `ReorderRule` (min qty, reorder
  qty, lead time, safety days, preferred supplier) is created, edited and
  deleted only through `reorder-rules.routes.ts`
  (`/stores/:storeId/stock/reorder-rules`, admin page
  `stock/reorder/rules`), via `storeWriter` (`ReorderRule` is in the DO write
  allow-list). Unique per (store, product, variant), enforced by the
  database: `reorder_rules_one_per_item` on (store_id, product_id,
  COALESCE(variant_id, '')), because a NULL `variant_id` is distinct in a plain
  unique index (Postgres migration 20261111000100, StoreDO `cf-0005`; both
  dedupe first, keeping the newest). A duplicate, including the loser of a
  simultaneous create, answers 409 `REORDER_RULE_EXISTS`. Every write is audit-logged
  (`reorder_rule.created|updated|deleted`); no money or stock effect.
- **A product-scoped write aimed at a variant product must fail loud.**
  `InventoryService.adjustInventory` / `bulkAdjustInventory` return a 400
  (`VARIANT_PRODUCT`) rather than writing a column that moves no stock. The
  CSV stock-adjustment import (`POST …/stock-adjustments/csv-import`) rejects
  such a row with a per-row error pointing at the variant SKU (2026-09-25).
  Known gap, not yet closed: the manual stock-adjustment form and the
  cycle-count reconcile still send product-level lines without a `variantId`.
- **A non-variant product may legitimately go negative** — that is real
  backorder debt. Only variant rows are floored at 0. Cancelling the
  backorder line that created the debt heals it back up to 0, never above
  (next section).

- **Warehouse stock writes follow the same rule** (issue 27). `WarehouseService.syncAggregateInventory`
  re-aggregates a VARIANT row from its `warehouse_stock` rows and stops there; it used to also write
  `SUM(product_variants.inventory)` into `products.inventory`, which for a variant product must stay 0.
  `setStock` / `adjustStock` with no `variantId` on a product that has variants now fail 400
  `VARIANT_PRODUCT` (set it per variant), and both bust the product caches after the write.

## Cancelling one backorder line

`cancelBackorder` (`POST …/backorders/:id/cancel`) takes back only that
line's unfulfilled units (`qty − qtyFulfilled`) — owner decision 2026-09-30,
ruling AP-5 in `docs/RULINGS.md`. In one transaction — the request's own
inside a request (so a rolled-back request leaves the line open and drops the
event together, issue 2276), a `withMoneyTx` outside one — it claims the line
(conditional on `cancelledAt: null`, so a second cancel is a 404) and writes a
`backorder_line_cancelled` orderEvent recording those units. After commit it
fires the ITEM-LEVEL `order/refunded` event (`partial`, refundKey
`backorder:<lineId>`, `restoreInventory: false`):

- the GL posts a pro-rata adjustment for that line through the partial-return
  path (`postPartialReturnJournal`): revenue net of its discount share, its
  VAT share, its COGS. The sale entry itself stays posted. Shipping is not
  reversed; a whole-order cancel still reverses the whole sale and backs these
  adjustments out first.
- coupon, affiliate, loyalty and wallet stay as they are — the order is
  still live. The item's other open backorder lines stay open.
- a line whose allocation is 0 (its units already reversed, or a fully
  discounted order) is still posted but tells the customer nothing (issue 2274).

**Stock: the debt is healed up to 0, never above** (owner decision
2026-10-01, #2277, ruling AP-5c). A NON-variant backordered checkout
force-decrements `products.inventory` unfloored, so the shortfall sits on the
row as a negative debt. In the same transaction and under the same claim, the
cancel restores `min(qty − qtyFulfilled, −inventory)`:

| Before cancel | Line's unfulfilled units | After cancel |
| ------------- | ------------------------ | ------------ |
| −3            | 5                        | 0            |
| −7            | 5                        | −2           |
| 4             | 3                        | 4 (nothing)  |

- It writes a `return_stock` InventoryHistory row with `reference`
  `backorder:<lineId>` (never the orderId — the whole-order restore reads an
  orderId-referenced `return_stock` row as "this order was already restored")
  and `createdBy` = the cancelling user, and busts the storefront product
  caches.
- It records the healed units as `stockRestored` on the
  `backorder_line_cancelled` marker. A later whole-order cancel/refund
  restores each item's quantity MINUS those units, so they are never put back
  twice (2 on hand, 5 backordered → −3 → line cancel → 0 → full cancel → 2).
- An untracked product, or one that is not negative, gets nothing: a line that
  left no debt cannot add phantom units. The units that were really on hand
  when the line was backordered are not returned by the line cancel — the
  owner chose that over ever inflating stock.
- **Variant lines heal nothing.** Checkout floors variant rows at 0
  (`forceDecrementVariantInventory`), so a variant backorder never drives stock
  negative and has no debt to heal.
- The `order/refunded` event itself still carries `restoreInventory: false`;
  the heal is done once, under the claim, not by the fanout.

**The two other ways a backorder leaves the backlog** (#2299, ruling AP-5d):

- **A PO receipt that fulfils a backorder heals the same debt, by the same
  rule.** The received units go to the customer, not the shelf, so PO receive
  clears the line without adding them to on-hand — and before this, left the
  non-variant debt on the row forever. It now heals `min(fulfilled units,
−inventory)` per cleared line (`return_stock` row, `reference`
  `po-backorder:<lineId>`); any remainder of the receipt goes on the shelf as
  before (0 on hand, 4 backordered → −4 → receive 7 → 0 + 3 = 3). Shared
  helper: `healBackorderStockDebt` (`accounting/backorder-stock-heal.ts`).
- **A whole-order cancel returns only what checkout actually took.**
  `backorder_lines.stock_taken` records it at checkout: the full qty for a
  non-variant line (the shortfall is negative debt), `min(qty, on-hand)` for a
  variant line (floored at 0). The whole-order restore subtracts
  `qty − stock_taken` per line, so a variant backorder no longer comes back
  with phantom units (2 on hand, 5 ordered → 0 → cancel → 2, was 5). NULL
  (lines written before the column) is treated as fully taken — the old
  behaviour. The variant sale's InventoryHistory row now records the real
  previous stock (2 → 0, not 5 → 0). Units a PO receipt later FULFILLED are
  not "never taken" (issue 2316): they went to the customer without touching
  the row, so the restore subtracts `qty − stock_taken − qty_fulfilled`
  (2 on hand, 5 ordered, PO fulfils 5 → cancel → 5, was 2).
- **A partial return that releases a backordered item's open line heals the
  same debt** (issue 2302). The fanout's `cancel-backorders` step claims each
  released line, heals `min(qty − qtyFulfilled, −inventory)` with the same
  helper (`return_stock` row, `reference` `backorder:<lineId>`) and records it
  as `stockRestored` on a `backorder_release_healed` orderEvent — a marker of
  its own, NOT `backorder_line_cancelled`, which feeds the GL's prior-reversed
  quantities. The whole-order restore subtracts it like the line-cancel one
  (2 on hand, 5 ordered → −3 → return 2 → −1 → release heals → 0 → full cancel
  → 2).

Every later item-level allocation — the GL, a return's provider refund, its
store credit — counts those units as already taken back
(`loadPriorReversedQty`, `accounting/posting/prior-reversed-qty.ts`), and
`ReturnService.create` does not let them be returned.

## Turning a single-variant product into a simple product

A product with exactly one variant can be flattened onto the product row by
`scripts/flatten-single-variant-products-2026-09-30.ts` (one-off, owner-applied).
It follows this page's rules:

- the variant's stock moves to `products.inventory` and the variant row is
  **deleted**, never disabled — a disabled variant still makes the product a
  variant product with stock 0 (Rulings SVF-1/SVF-2 in `docs/RULINGS.md`);
- price, compare-at, cost, SKU, barcode, weight and backorder flag move with
  it, `has_variants` becomes false, and the option ("Size: 380 Gram" /
  "الحجم: 380 جرام") is appended to both descriptions unless already stated;
- every row that pointed at the variant is moved first (cart lines, the
  warehouse shadow, reorder rules; order lines only with
  `--unlink-order-lines`); PO / stock-adjustment / backorder / bundle /
  count lines block the product;
- a zero-quantity `adjustment` InventoryHistory row records the move
  (`reference = flatten-variant:<variantId>`), and the product caches are
  busted — `--restore <backup>` reverses it with the original ids.

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

Eleven read paths then consumed that drift. Measured on the `demo-store`
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

Gold-rate pricing changes a product's PRICE, never its stock: the repricer writes `price` only, and `inventory` rules above are untouched (`docs/architecture/gold-rate-pricing.md`).
