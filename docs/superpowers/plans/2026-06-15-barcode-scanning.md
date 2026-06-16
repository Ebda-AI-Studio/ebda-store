# Barcode Scanning — Implementation Plan

_Date: 2026-06-15 | Feature: `inventory.barcode` | Plan tier: Enterprise_

## Goal

Make the claim true: **"Scan barcodes from a mobile device to receive stock, pick orders,
and audit inventory counts."**

Only the barcode string columns existed before this plan. No scan workflow existed.

---

## Prior art + known traps

- `Product.barcode` (nullable) and `ProductVariant.barcode` (nullable) already exist at
  schema lines ~619 and ~856. No DB index on either column yet — lookup without an index
  on a large product table is a full scan.
- `StockAdjustment` + `postAdjustment` service already handles qty reconciliation +
  GL journal posting + InventoryHistory creation. Reuse this for cycle-count reconcile.
- OrderItem has no `pickedAt` / picked state. We add a minimal `pickedQty` column
  (additive, never breaks existing rows — defaults to 0) plus a `pickedAt` timestamp.
- BarcodeDetector Web API is available in Chrome/Safari on mobile. Fallback to manual
  entry input. Zero external scanner lib needed for native path.
- RLS is FORCE-on across all tenant tables. Any new model needs the same policy pattern
  as existing tables (`store_id = current_setting('app.current_client_id')::uuid`).

---

## Scope

### 1. DB Migration (`20260615000000_barcode_scanning`)

1. **Index** on `products(store_id, barcode)` and `product_variants(product_id, barcode)`.
2. **CountSession** — one audit/cycle-count session per store (open → closed).
3. **CountLine** — one row per product/variant scanned in a session.
4. **OrderItem** — add `picked_qty INT NOT NULL DEFAULT 0` + `picked_at TIMESTAMPTZ`.
5. RLS policies for the two new tables.

### 2. API routes (added to `inventory.routes.ts`)

| Method | Path                                                             | Gate                | Purpose                                      |
| ------ | ---------------------------------------------------------------- | ------------------- | -------------------------------------------- |
| GET    | `/stores/:storeId/inventory/lookup`                              | `inventory.barcode` | Resolve barcode → product/variant            |
| POST   | `/stores/:storeId/inventory/receive`                             | `inventory.barcode` | Scan-to-receive stock (wraps adjust service) |
| POST   | `/stores/:storeId/inventory/pick`                                | `inventory.barcode` | Scan-to-pick order line item                 |
| GET    | `/stores/:storeId/inventory/count-sessions`                      | `inventory.barcode` | List sessions                                |
| POST   | `/stores/:storeId/inventory/count-sessions`                      | `inventory.barcode` | Open a session                               |
| GET    | `/stores/:storeId/inventory/count-sessions/:sessionId`           | `inventory.barcode` | Get session detail                           |
| POST   | `/stores/:storeId/inventory/count-sessions/:sessionId/lines`     | `inventory.barcode` | Submit a scanned count line                  |
| POST   | `/stores/:storeId/inventory/count-sessions/:sessionId/close`     | `inventory.barcode` | Close session (no more lines)                |
| POST   | `/stores/:storeId/inventory/count-sessions/:sessionId/reconcile` | `inventory.barcode` | Convert variances into StockAdjustment       |

### 3. Admin UI (Next.js)

Route: `/stores/[id]/stock/scan`

Three-mode mobile-first page:

- **Receive** — scan → show product info → enter qty received → POST /receive
- **Pick** — enter order number → scan items to pick → track progress → mark order fully picked
- **Count** — open/resume session → scan items + enter counted qty → review variances → reconcile

Camera via `BarcodeDetector` API + `getUserMedia`. Manual text input fallback.
No heavy external library. If BarcodeDetector unavailable (Firefox desktop), falls back
to manual entry gracefully.

### 4. Hub tab

Add "Scan" tab to the stock hub in `hubs.ts`.

### 5. Tests

Unit:

- `tests/unit/barcode-lookup.test.ts` — found / not-found / ambiguous (barcode hits both product and variant)
- `tests/unit/barcode-variance.test.ts` — variance computation logic
- `tests/unit/barcode-pick-state.test.ts` — pick state transitions (none→partial→complete)

Integration (if harness supports):

- `tests/integration/barcode-scan.test.ts` — lookup + receive endpoints with real DB

### 6. Doc parity

- `packages/shared/src/features.ts` — description already correct, `hidden: false` (already)
- `docs/business/02-feature-catalog.md` — add implementation status note
- `docs/business/plan-feature-matrix.md` — update status cell
- `ROADMAP.md` — already checked ✓

---

## Quality gates

- Zod at every endpoint edge
- Explicit `select` (no `findMany` returning full row when only subset needed)
- `runInTenantContext` wrapping all DB calls in new routes
- `postAdjustment` reused as-is for reconcile (no duplicate GL logic)
- Migration additive — `DEFAULT 0` on `picked_qty`, existing OrderItems unaffected
- `npm audit` clean — no new deps (zero scanner lib)
