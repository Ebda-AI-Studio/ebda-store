# WarehouseStock Data-Integrity Fixes — Design Spec

**Status:** pending review. **Item:** OSOSS program, item 5 (trimmed — Ahmad, 2026-07-23).
**Scope decision (Ahmad):** "just fix the 2 bugs" — NO reserved/ATP feature (Ebda Store already decrements
at order → already oversell-safe + ATP-correct), NO cross-warehouse transfer workflow. This is a
**data-integrity fix**, not a new feature surface.
**Branch/worktree:** `feat/inventory-atp-reserved` → `_worktrees/ebda-store__feat-inventory-atp-reserved`.
**Deploy:** develop-now, merges in the deploy-all-at-once batch.

---

## 1. Problem (verified against source, 2026-07-23)

Ebda Store's authoritative inventory is `Product.inventory` / `ProductVariant.inventory`: decremented
atomically at **order placement** (`inventory-decrement.ts`, `WHERE inventory >= qty`), restored on
cancel/refund (`order-refunded.ts`) and payment-rollback (`order.service.ts:885`). Storefront badges
(`enrichStockFlags`) and checkout both read only this aggregate. **It is already oversell-safe and
ATP-correct — no reserved column is needed** (that's why Ahmad cut reserved/ATP from scope).

`WarehouseStock` (Enterprise `inventory.multi_warehouse` only) is a **per-warehouse shadow** that is
kept consistent ONE WAY: admin `setStock`/`adjustStock` write a `WarehouseStock` row then call
`syncAggregateInventory` (SUM(WarehouseStock) → `Product.inventory`). Two real bugs:

**BUG 1 — Drift.** `Product.inventory` has **four independent writers**; only `syncAggregateInventory`
is warehouse-aware. The other three write the aggregate directly and never touch `WarehouseStock`:

- order decrement + the two restore paths (`order.service.ts`, `order-refunded.ts`),
- single-SKU `InventoryService.adjustInventory`/`setInventory`,
- accounting `StockAdjustment.postAdjustment`.
  So after the first sale/adjustment on any SKU that also has warehouse rows,
  `SUM(WarehouseStock.quantity) != Product.inventory` — the per-warehouse admin view goes stale/wrong
  forever until a manual `setStock` on that exact SKU+warehouse happens to resync (and even then it
  mis-attributes the whole delta to whichever warehouse got touched).

**BUG 2 — Lost-update race.** `setStock`/`adjustStock` (`warehouse.service.ts:469-596`) do
`findFirst → update/create` as **unguarded round-trips, no `$transaction`/row lock**. Two concurrent
admin edits to the same `(warehouseId, productId, variantId)` both read the old qty → one delta is
silently lost. `syncAggregateInventory`'s own `aggregate → update` pair is unguarded the same way.

Non-goals: reserved/committed/ATP columns; wiring `routeOrder` into checkout (it stays an admin
preview); a warehouse-to-warehouse transfer workflow (`transfer_out` stays a dead enum); any change
to the oversell-safe checkout decrement itself.

## 2. Key design principle — reconcile the shadow, never touch the money path

`WarehouseStock` is **never read by checkout or the storefront** — only the admin per-warehouse view.
So it does NOT need to be transactionally consistent with each sale in real time; **eventual
consistency is sufficient.** Therefore: keep `Product.inventory` authoritative and untouched, and
**reconcile `WarehouseStock` to match it** — the invariant we maintain is
`SUM(WarehouseStock.quantity for a SKU) == Product.inventory` (per SKU, per store-with-warehouses).
This means **zero changes to the order-creation money transaction** (the highest-risk surface).

## 3. Fix design

### 3a. BUG 2 — the race (contained, clearly correct)

Wrap `setStock`, `adjustStock`, and `syncAggregateInventory` so each read-modify-write is atomic:

- `adjustStock`: replace `findFirst(qty) → clamp → update` with an **atomic guarded upsert/increment**
  inside `prisma.$transaction`, taking a row lock on the `(warehouseId, productId, variantId)` row
  (`SELECT … FOR UPDATE`, or a raw `INSERT … ON CONFLICT DO UPDATE SET quantity = GREATEST(0,
quantity + delta) RETURNING`), so concurrent deltas serialize (mirror the discipline already used
  in `answer_engine`/checkout paths). `setStock` (absolute) upserts under the same lock.
- `syncAggregateInventory`: run its `aggregate → update` inside the same transaction (or a locked
  one) so a concurrent sync can't clobber.
- Do them within the SAME transaction as the WarehouseStock write so the row-write + resync are one
  atomic unit (no window where WarehouseStock changed but the aggregate hasn't).

### 3b. BUG 1 — the drift (reconcile to the authoritative aggregate)

Add `WarehouseService.reconcileWarehouseStockToAggregate(storeId, productId, variantId)`:

- No-op fast path if the store has no warehouses (single-/no-warehouse stores — most merchants —
  are unaffected and pay ~one indexed existence check).
- Else: read authoritative `Product.inventory`/`ProductVariant.inventory` and `SUM(WarehouseStock)`
  for the SKU; if they differ, **absorb the difference into the store's DEFAULT warehouse**
  (`Warehouse.isDefault`, else lowest-priority/first active) so `SUM == aggregate` holds again. All
  inside a transaction with the same row-lock discipline as 3a. (Attribution to the default warehouse
  is the honest trimmed choice — true which-warehouse-fulfilled needs the declined checkout-routing
  scope; a per-warehouse number that stays _arithmetically consistent with the truth_ beats silent
  drift, and the default may legitimately show a low/zero count signalling "restock/reattribute.")
- Call it right after every direct aggregate writer:
  - **Admin paths (sync, low risk):** at the end of `InventoryService.adjustInventory`/`setInventory`
    and `StockAdjustment.postAdjustment` — reconcile in the same tenant context.
  - **Order paths (money path UNTOUCHED):** hang reconciliation off the existing post-order Inngest
    fanout (`order/created`, `order/status-changed`, `order/refunded`) as a retriable `step.run` per
    changed SKU — the checkout transaction itself is not modified. Eventual consistency is fine (the
    number only surfaces in the admin view).
- Admin "Reconcile to aggregate" action + a one-time **backfill** (script or admin-triggered) to fix
  already-drifted data for existing multi-warehouse stores.

## 4. Every-data-needs-a-UI / discoverability

- The per-warehouse view already exists (`/stock/warehouses/[warehouseId]`). Add a small
  "Reconcile to aggregate" button (calls the reconcile endpoint) so a merchant can force a resync,
  and surface a subtle "counts reconciled from authoritative stock" note. Bilingual EN+AR.
- No new model, no new list. The fix is behavioral + one admin action + the backfill.

## 5. Security & correctness

- All writes tenant-scoped (`storeId`) under `runInTenantContext` + RLS (WarehouseStock already has
  the tenant policy). The reconcile endpoint uses the same
  `authenticate → authorize → requireStoreAccess → requireFeature('inventory.multi_warehouse')` chain
  as the rest of `warehouse.routes.ts`.
- Integer quantities; clamp negatives per existing convention (or allow a signalling negative on the
  default warehouse — decide at plan time, test either way).
- The authoritative aggregate + the oversell guard are NOT modified — checkout behaviour is unchanged
  (regression tests on the existing order/decrement suite must stay green).

## 6. Testing

- **Unit:** the atomic `adjustStock` (delta clamps, upsert-on-first-touch); `reconcile` math
  (default-warehouse absorbs the diff; no-op when SUM already == aggregate; no-op when no warehouses).
- **Integration (Postgres):** the race — two concurrent `adjustStock` deltas on one row both land
  (no lost update); the drift invariant — after a sale, after a single-SKU adjust, after a
  stock-adjustment post, `SUM(WarehouseStock) == Product.inventory` holds (via the reconcile hook /
  fanout step); the backfill fixes a seeded drifted SKU; the reconcile endpoint is Enterprise-gated +
  tenant-isolated (store B can't reconcile store A).
- **Regression:** the existing order-decrement / refund-restore / oversell suites stay green
  (proves the money path is untouched).
- **Blast-radius:** every `Product.inventory`/`ProductVariant.inventory` direct writer (the 4) is
  covered by a reconcile hook; `syncAggregateInventory` callers; the fanout registration; the new
  route + admin action.

## 7. Open items for planning

- Exact atomic-upsert SQL vs `$transaction`+`FOR UPDATE` (match the codebase's prevailing idiom).
- Whether reconciliation for sales rides `order/status-changed` fanout vs a dedicated event; confirm
  the fanout already fires on create + refund and carries the changed SKUs.
- Negative-on-default vs clamp-and-track-residual for the absorb step.
- Backfill as a one-shot admin endpoint vs a script (prefer an idempotent admin-triggered endpoint,
  Enterprise-gated, so no deploy-time migration risk).
