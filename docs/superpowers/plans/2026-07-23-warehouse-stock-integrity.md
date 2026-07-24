# WarehouseStock Data-Integrity Fixes — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Fix two `WarehouseStock` bugs — the lost-update race in `setStock`/`adjustStock`, and the per-warehouse drift (aggregate diverges from `SUM(WarehouseStock)` after sales/adjustments) — WITHOUT touching the oversell-safe order-decrement money path.

**Architecture:** `Product.inventory` stays authoritative + untouched. `WarehouseStock` (Enterprise `inventory.multi_warehouse` only, never read by checkout/storefront) is reconciled _to_ the aggregate via a new `reconcileWarehouseStockToAggregate` helper that absorbs any `Product.inventory − SUM(WarehouseStock)` difference into the store's default warehouse. Admin writers reconcile inline; sales reconcile async via the existing order Inngest fanout. `setStock`/`adjustStock`/`syncAggregateInventory` become atomic + row-locked.

**Tech Stack:** Express + TS (`apps/api`), Prisma + Neon (raw SQL for atomic upsert / `FOR UPDATE`), Inngest fanout, Next.js admin, Vitest.

**Source of truth:** spec `docs/superpowers/specs/2026-07-23-warehouse-stock-integrity-design.md`.

## Global Constraints

- **The oversell-safe order-decrement transaction is NOT modified.** Sales reconcile ASYNC via the order fanout; the checkout `$queryRaw UPDATE … WHERE inventory >= qty` stays exactly as-is. Existing order/decrement/refund regression suites MUST stay green.
- **Invariant:** for a store WITH warehouses, `SUM(WarehouseStock.quantity for a SKU) == Product.inventory` (and per-variant `== ProductVariant.inventory`). Reconcile maintains it; no-op fast path when the store has no warehouses (single-/no-warehouse stores unaffected — cheap indexed existence check).
- **Atomicity:** every `WarehouseStock` read-modify-write runs inside `prisma.$transaction` with a row lock (`SELECT … FOR UPDATE`) or an atomic `INSERT … ON CONFLICT DO UPDATE … RETURNING`. No unguarded `findFirst → update`.
- **Attribution:** the diff is absorbed into the DEFAULT warehouse (`Warehouse.isDefault`; fallback = lowest `priority` among `isActive`, else first). Honest trimmed choice; a negative/low default count is a visible signal, not silent total-drift.
- **Tenant-scoped** (`storeId`, `runInTenantContext`, RLS). Reconcile endpoint gated `authenticate → authorize('store_admin','super_admin') → requireStoreAccess → requireFeature('inventory.multi_warehouse')` (mirror `warehouse.routes.ts`).
- **Integer quantities**; keep the existing clamp-at-0 convention unless a signalling negative is chosen (decide + test in Task 2).
- **commitlint** lowercase subject; blank line before `Co-Authored-By`; `git add` specific paths; don't dirty package-lock.json. Typecheck + lint clean.
- **PREFLIGHT before push:** add `.superpowers/` to `.prettierignore` + prettier-format the committed spec/plan md (this branch lacks the item-7 fix).

---

## File Structure

**Modify:**

- `apps/api/src/services/warehouse.service.ts` — atomic `setStock`/`adjustStock`/`syncAggregateInventory` (Task 1); new `reconcileWarehouseStockToAggregate` + `backfillReconcileAll` (Task 2).
- `apps/api/src/services/inventory.service.ts` — call reconcile after `adjustInventory`/`setInventory` (Task 3).
- `apps/api/src/services/accounting/stock-adjustment.service.ts` — call reconcile after `postAdjustment` (Task 3).
- `apps/api/src/lib/inngest/functions/` — reconcile step on the order fanout (create/status-changed/refunded) (Task 4).
- `apps/api/src/routes/warehouse.routes.ts` — `POST .../warehouses/reconcile` + `.../warehouses/reconcile-all` (Task 5).
- `apps/admin/src/app/stores/[id]/stock/warehouses/[warehouseId]/page.tsx` (+ i18n) — "Reconcile to aggregate" action (Task 5).
- `docs/ENVIRONMENT.md` (none expected), `docs/business/plan-feature-matrix.md` (note under multi-warehouse) (Task 5).

**Create:** tests under `apps/api/src/services/__tests__/` (unit) + `tests/integration/warehouse/*`.

---

## Task 1: Atomic `setStock` / `adjustStock` / `syncAggregateInventory` (race fix)

**Files:** `apps/api/src/services/warehouse.service.ts`, `tests/integration/warehouse/stock-race.test.ts`.

READ `warehouse.service.ts:469-642` first — confirm the exact `setStock`/`adjustStock`/`syncAggregateInventory` signatures + the `StockSetInput`/`StockAdjustInput` types before editing.

- [ ] **Step 1: Failing integration test** — seed a warehouse + a `WarehouseStock` row at qty 100; fire N concurrent `adjustStock(delta=+1)` (e.g. `Promise.all` of 20) → assert final qty is 120 (no lost update). Repeat with mixed +/− deltas. (Today this loses updates.)
- [ ] **Step 2: Run → fails** (final qty < expected). `DATABASE_URL=<scratch> npx vitest run tests/integration/warehouse/stock-race.test.ts`
- [ ] **Step 3: Implement** — rewrite `adjustStock` to a single atomic statement inside `prisma.$transaction`: `INSERT INTO "warehouse_stock" (...) VALUES (...) ON CONFLICT ("warehouse_id","product_id","variant_id") DO UPDATE SET quantity = GREATEST(0, "warehouse_stock".quantity + ${delta}), updated_at = now() RETURNING quantity` (raw SQL; the `@@unique([warehouseId, productId, variantId])` backs the conflict target). `setStock` (absolute) = same upsert with `SET quantity = ${qty}`. Run `syncAggregateInventory` INSIDE the same transaction, and make ITS `aggregate → update` safe (either recompute-in-tx or a locked update). Keep the return shapes.
- [ ] **Step 4: Run → passes** (final qty exact).
- [ ] **Step 5: Commit** — `fix(api): atomic row-safe warehouse setStock/adjustStock (lost-update race)`

---

## Task 2: `reconcileWarehouseStockToAggregate` helper + backfill

**Files:** `apps/api/src/services/warehouse.service.ts`, `apps/api/src/services/__tests__/warehouse-reconcile.test.ts`, `tests/integration/warehouse/reconcile.test.ts`.

**Interfaces:** Produces `reconcileWarehouseStockToAggregate(storeId, productId, variantId): Promise<{ reconciled: boolean; diff: number }>` and `backfillReconcileAll(storeId): Promise<{ skusReconciled: number }>`.

- [ ] **Step 1: Failing tests** —
  - unit: a `resolveDefaultWarehouse(storeId)` picks `isDefault`, else lowest-priority active, else first; throws/returns null cleanly if none.
  - integration: store WITH one warehouse, `WarehouseStock` qty 10, then `Product.inventory` set to 7 directly (simulating a drifted sale) → `reconcile` sets the default warehouse's row to 7 so `SUM == 7`. Store with NO warehouses → `{reconciled:false}` no-op, zero writes. Already-consistent SKU → `{reconciled:false}`. Variant SKU → reconciles the variant row + keeps product-level consistent.
- [ ] **Step 2: Run → fails.**
- [ ] **Step 3: Implement** — `reconcileWarehouseStockToAggregate`: fast-path `count` of `Warehouse` for the store (no-op if 0). Else, inside `prisma.$transaction` (row-locking the SKU's default-warehouse `WarehouseStock` row + reading authoritative `Product/Variant.inventory`): compute `diff = aggregate − SUM(WarehouseStock)`; if `diff != 0`, apply `diff` to the default warehouse's row (upsert, `GREATEST(0, …)` OR allow negative per the Task-decision — pick one, document, test it). `backfillReconcileAll`: iterate the store's SKUs that have any `WarehouseStock` row, reconcile each (batched). Idempotent (re-run = no further change).
- [ ] **Step 4: Run → passes.**
- [ ] **Step 5: Commit** — `feat(api): reconcile warehouse stock to authoritative aggregate + backfill`

---

## Task 3: Wire reconcile into the admin direct-writers (sync)

**Files:** `apps/api/src/services/inventory.service.ts`, `apps/api/src/services/accounting/stock-adjustment.service.ts`, `tests/integration/warehouse/reconcile-admin-writers.test.ts`.

READ `inventory.service.ts:296-360,494-540` + `stock-adjustment.service.ts:116-169` — confirm where each finishes mutating `Product/Variant.inventory`, and its tenant-context.

- [ ] **Step 1: Failing integration test** — store WITH a warehouse; via `InventoryService.adjustInventory` change a SKU's aggregate → assert `SUM(WarehouseStock) == Product.inventory` afterward. Same via `StockAdjustment.postAdjustment` (a posted adjustment). (Today both drift.)
- [ ] **Step 2: Run → fails** (SUM != aggregate).
- [ ] **Step 3: Implement** — call `reconcileWarehouseStockToAggregate(storeId, productId, variantId)` at the END of `adjustInventory`/`setInventory` and after `postAdjustment` commits, in the same tenant context, for each affected SKU. For `postAdjustment` (inside `withMoneyTx`), reconcile AFTER the money tx commits (post-commit hook / same-request follow-up) so a reconcile failure can't roll back a posted accounting adjustment — reconcile is best-effort + retriable, log on failure. No-op fast path keeps single-warehouse stores unaffected.
- [ ] **Step 4: Run → passes.**
- [ ] **Step 5: Commit** — `fix(api): reconcile warehouse stock after single-sku + stock-adjustment writes`

---

## Task 3.5 (COMPLETENESS — added after Task 3 review): the reconcile SWEEP is the class-fix

**Why:** the Task-3 review found the direct-writer set is larger than the extraction named — `bulkAdjustInventory`, `VariantService.bulkUpdateInventory`, `ProductService.updateInventory` + `bulkUpdate` inventory branches, `barcode-scan` variant branch, `purchase-order` PO-receive/WAC — ~6 more un-hooked writers, and future writers will drift too. Hooking each is fragile + incomplete. **The robust class-fix is a scheduled sweep + reconcile-on-view**, since `WarehouseStock` is admin-view-only (eventual consistency is sufficient). Task 3's per-writer hooks stay as the IMMEDIATE layer for the common admin paths; the sweep is the COMPLETENESS layer for all writers. This is folded into Task 4 below (async reconcile). No need to hook the other ~6 writers individually — document that they rely on the sweep/on-view/on-demand reconcile (eventual), which is acceptable for an admin-only shadow.

## Task 4: Async reconcile — order fanout (sales/restores) + daily completeness SWEEP (money path UNTOUCHED)

**Files:** `apps/api/src/lib/inngest/functions/*` (the order fanout — confirm the exact file/function that fans out `order/created` + `order/status-changed` + `order/refunded`), `tests/integration/warehouse/reconcile-orders.test.ts`.

READ the order fanout (`order-status-changed-fanout` + `order-refunded.ts`) — confirm the event names, that they carry the order's line-item SKUs (or load them), and how a retriable `step.run` side-effect is added (mirror an existing fanout step).

- [ ] **Step 1: Failing integration test** — store WITH a warehouse + a product with `WarehouseStock == Product.inventory`; place a guest order for qty 2 (drops `Product.inventory` by 2 via the untouched decrement); drive the fanout (invoke the on-demand/fanout handler) → assert `SUM(WarehouseStock) == Product.inventory` (default warehouse absorbed −2). Then refund → aggregate restored by +2 → reconcile again → invariant holds. Assert the checkout transaction itself is unchanged (the decrement test fixtures still pass).
- [ ] **Step 2: Run → fails** (warehouse not reconciled after the sale).
- [ ] **Step 3: Implement** — add a retriable `step.run('reconcile-warehouse-stock', …)` to the order fanout for `order/created` (sale) and `order/refunded` (restore) — and any `order/status-changed` transition that restores stock (cancel) — iterating the order's SKUs and calling `reconcileWarehouseStockToAggregate` under the order's tenant context. Dead-letter on failure via the existing `alerts-failure-watch` pattern. Do NOT modify `order.service.ts`'s decrement. Register nothing new if it's a step inside an existing fanout function; if a new function, register in `functions/index.ts` + the `AppEvent` union (INNGEST_DEPLOY_ID note).
- [ ] **Step 4: Run → passes.** Confirm the existing order/decrement/refund suites still green (regression).
- [ ] **Step 5: Commit** — `fix(api): reconcile warehouse stock on order sale/refund via fanout (money path untouched)`

---

## Task 5: Admin reconcile action + backfill endpoint + docs + blast-radius

**Files:** `apps/api/src/routes/warehouse.routes.ts`, `apps/admin/.../stock/warehouses/[warehouseId]/page.tsx` (+ i18n), `docs/*`, `tests/integration/warehouse/reconcile-endpoint.test.ts`.

- [ ] **Step 1: Failing integration test** — `POST /stores/:storeId/warehouses/reconcile-all` on a store with a seeded drifted SKU → returns `{skusReconciled: N}` and the invariant holds afterward; a non-Enterprise store → 403/402 (feature gate); a store-B admin hitting store-A's URL → 403 (tenant isolation).
- [ ] **Step 2: Run → fails.**
- [ ] **Step 3: Implement** — `POST .../warehouses/reconcile` (single SKU) + `.../warehouses/reconcile-all` (backfill), same middleware chain as sibling warehouse routes (`requireFeature('inventory.multi_warehouse')`). Admin: a "Reconcile to aggregate" button on the per-warehouse page calling `reconcile-all`, with a subtle "per-warehouse counts are reconciled from authoritative stock" note; bilingual EN+AR.
- [ ] **Step 4: Run → passes.**
- [ ] **Step 5: Docs + blast-radius** — `docs/business/plan-feature-matrix.md` note (behavioral fix under existing multi-warehouse; no new key); blast-radius sweep (every `Product/Variant.inventory` direct writer now has a reconcile hook; `syncAggregateInventory` callers; the fanout step; the new routes + admin action; `WarehouseStock` invariant). State the result.
- [ ] **Step 6: Commit** — `feat: warehouse reconcile admin action + backfill endpoint + docs`

---

## Final verification (before PR)

- [ ] typecheck + lint clean; warehouse unit + integration suites green; **existing order/decrement/refund regression suites green** (proves the money path is untouched).
- [ ] Whole-branch review (Opus): the invariant holds across all 4 writers; the money path is genuinely untouched; the atomic upsert is race-safe; tenant isolation + Enterprise gate on the endpoint; reconcile is idempotent + best-effort (a reconcile failure never corrupts the authoritative aggregate or blocks a sale).
- [ ] Prettier preflight (`.superpowers/` ignored; format spec+plan). Blast-radius statement in the PR body. PR → main, NOT merged (deploy-all-at-once batch).
