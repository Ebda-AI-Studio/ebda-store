# Multi-Warehouse Inventory — Implementation Plan

**Date:** 2026-06-15  
**Feature flag:** `inventory.multi_warehouse` (Enterprise tier — already defined in `plan-baselines.ts`)  
**Goal:** Make the claim "Track stock counts per warehouse and route orders by proximity or custom rule" TRUE.

---

## 1. Data Model (additive)

### `Warehouse`

| Column     | Type                      | Notes                                  |
| ---------- | ------------------------- | -------------------------------------- |
| id         | UUID PK                   |                                        |
| store_id   | UUID FK → stores          | tenant key; RLS policy on this         |
| name       | TEXT NOT NULL             | display name                           |
| name_ar    | TEXT                      | Arabic name                            |
| code       | TEXT NOT NULL             | short code e.g. "MAIN", "KWT-2"        |
| is_default | BOOLEAN DEFAULT false     | only one per store                     |
| priority   | INT DEFAULT 0             | higher = preferred in priority routing |
| lat        | FLOAT                     | optional; enables proximity routing    |
| lng        | FLOAT                     | optional; enables proximity routing    |
| address    | TEXT                      | human-readable                         |
| is_active  | BOOLEAN DEFAULT true      | soft disable without delete            |
| created_at | TIMESTAMPTZ DEFAULT now() |
| updated_at | TIMESTAMPTZ DEFAULT now() |

Unique constraint: `(store_id, code)`  
Index: `(store_id)`, `(store_id, is_default)`, `(store_id, priority DESC)`  
@@map: `warehouses`

### `WarehouseStock`

| Column       | Type                                | Notes                     |
| ------------ | ----------------------------------- | ------------------------- |
| id           | UUID PK                             |                           |
| warehouse_id | UUID FK → warehouses                |                           |
| product_id   | UUID FK → products                  |                           |
| variant_id   | UUID FK → product_variants nullable | NULL = base product stock |
| quantity     | INT NOT NULL DEFAULT 0              |                           |
| created_at   | TIMESTAMPTZ DEFAULT now()           |
| updated_at   | TIMESTAMPTZ DEFAULT now()           |

Unique: `(warehouse_id, product_id, variant_id)` — variant_id nullable unique handled via partial index  
Index: `(warehouse_id)`, `(product_id)`, `(variant_id)`  
@@map: `warehouse_stock`

---

## 2. Migration Strategy

Migration name: `20260615000000_multi_warehouse`

Steps:

1. CREATE TABLE warehouses + RLS policy (hybrid: IS NULL OR bypass OR store_id match)
2. FORCE ROW LEVEL SECURITY on warehouses
3. CREATE TABLE warehouse_stock + RLS (join through warehouses.store_id via subquery)
4. FORCE ROW LEVEL SECURITY on warehouse_stock
5. **Backfill:** for every existing store, create one default warehouse (name="Main Warehouse", code="MAIN", is_default=true, priority=100)
6. **Backfill:** for each product with `track_inventory=true`, create a `warehouse_stock` row in that store's default warehouse seeded from `product.inventory`
7. Same for `product_variants` (by productId → store → default warehouse)

The existing `Product.inventory` / `ProductVariant.inventory` columns remain unchanged — they are the aggregate (kept in sync on every WarehouseStock write via trigger or service-layer sum).

---

## 3. API Endpoints (all behind `requireFeature('inventory.multi_warehouse')`)

Mounted at `/stores/:storeId/warehouses` and `/stores/:storeId/warehouse-stock`.

### Warehouses

- `GET /` — list warehouses for store (includes stock totals)
- `POST /` — create warehouse (Zod-validated)
- `GET /:warehouseId` — get single warehouse
- `PUT /:warehouseId` — update warehouse
- `DELETE /:warehouseId` — soft-delete (set is_active=false, block if it's the only default)

### Warehouse Stock

- `GET /?productId=&variantId=` — per-product/variant breakdown across all warehouses
- `PUT /:warehouseId/stock` — set stock for a product/variant in a warehouse (Zod-validated); updates WarehouseStock + re-aggregates Product.inventory
- `POST /:warehouseId/adjust` — delta adjustment (reuses InventoryChangeType journal pattern, creates InventoryHistory row)

### Order Routing

- `POST /route-order` — given `{ items: [{productId, variantId, qty}], lat?, lng? }`, returns `{ warehouseId, warehouseName, rule: 'priority' | 'proximity' }` per line item

---

## 4. Routing Rules

Two rules (extensible):

1. **Priority routing (default):** pick the warehouse with highest `priority` that has `quantity >= qty` for the item. Tiebreak: alphabetical by code.
2. **Proximity routing:** if `lat/lng` provided AND at least one warehouse has `lat/lng` set, pick the nearest warehouse (Haversine formula) with sufficient stock. Falls back to priority if no warehouses have coordinates.

The rule is determined per-order at checkout, not at product level. If no warehouse has sufficient stock: return the warehouse with the most stock (partial fulfillment indicator) + `insufficientStock: true`.

---

## 5. Aggregate Sync Strategy

Problem: `Product.inventory` and `ProductVariant.inventory` must remain accurate for storefront (existing stock-badge, backorder logic) when the feature is ON.

**Decision:** Service-layer sync — every `WarehouseStock` write re-aggregates by SUM(quantity) across all warehouses for that product/variant and writes back to `Product.inventory` / `ProductVariant.inventory` in the same transaction. Avoids DB triggers (hard to test) and keeps the existing storefront read path unchanged.

When the feature is OFF (feature flag not enabled), all inventory reads/writes go through the existing paths — no WarehouseStock rows are involved.

---

## 6. Admin UI

### `/stores/[id]/stock/warehouses` (new page)

- List all warehouses (name, code, priority, is_default, location, total SKUs, total units)
- "New Warehouse" modal (name, name_ar, code, priority, is_default, lat/lng, address)
- Edit inline or modal
- Set as default button
- Reorder priority (up/down arrows or drag)

### `/stores/[id]/stock/warehouses/[warehouseId]` (new page)

- Per-warehouse stock list: product, variant, qty, low-stock badge
- Inline quantity edit (save-on-blur)
- Quick adjust delta modal

---

## 7. Tests

**Unit tests** (`tests/unit/multi-warehouse-routing.test.ts`):

- `routeOrder` with priority rule: picks highest-priority warehouse with stock
- `routeOrder` skips out-of-stock warehouses even if higher priority
- `routeOrder` proximity rule: picks nearest warehouse with stock (Haversine)
- `routeOrder` falls back to priority when no coordinates available
- `routeOrder` returns partial-fulfillment warehouse when all are short
- Backfill correctness: each product gets WarehouseStock row = product.inventory

**Integration test** (`tests/integration/warehouse-crud.test.ts`):

- Create warehouse → list → update → stock adjust → aggregate sync → cleanup

---

## 8. Doc Parity (same PR)

- `packages/shared/src/features.ts` — update `inventory.multi_warehouse` description
- `docs/business/02-feature-catalog.md` — add multi-warehouse row
- `docs/business/plan-feature-matrix.md` — verify Enterprise row already has it
- `ROADMAP.md` — flip multi-warehouse item to done
