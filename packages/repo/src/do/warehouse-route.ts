import type { SyncSql } from './sync-sql';
import { reconcileToAggregate, upsertWarehouseStock } from './stock-ops';

/**
 * Ruling WAREHOUSE-ROUTE-1 + 3: order creation routes each stock line to a warehouse (or, when no single one holds the whole
 * line, splits it across several), in the same StoreDO section as the order.
 *
 * `Product.inventory` / `ProductVariant.inventory` stays the authoritative, oversell-guarded number (checkout is unchanged);
 * the warehouse rows are the per-location shadow whose SUM equals it. Routing keeps that invariant: the SKU's shadow is first
 * reconciled to the aggregate (a no-op when already equal), the line goes to the best warehouse that can fulfil the WHOLE line
 * (priority desc, code asc: the rule of `WarehouseService.routeOrder`); when none can, it is split greedily by that same
 * order (Ruling WAREHOUSE-ROUTE-3: an order the aggregate covers is never refused). The aggregate is decremented as before
 * (the oversell guard), then each chosen warehouse row is decremented by its chunk. One allocation per (line, warehouse) is
 * stored in the order event `warehouse_allocated`; a cancel / refund / partial return reads it and puts the units back into
 * the SAME warehouses, lowest priority first (`warehouse_released` events keep what was already given back per
 * (line, warehouse), so a second return never returns more than was taken).
 *
 * A store with fewer than 2 active warehouses is NOT routed at all: `planRoute` returns null and every statement is exactly
 * what it was before this file existed (single / no-warehouse stores keep byte-identical stock math).
 */
const ALLOCATED_EVENT = 'warehouse_allocated';
const RELEASED_EVENT = 'warehouse_released';

export interface Allocation {
  /** the order line this came from (Ruling WAREHOUSE-ROUTE-2: give-backs are keyed per line, not per product) */
  orderItemId?: string;
  /** checkout only, before the order_items rows exist: index of the line; `recordAllocations` turns it into `orderItemId` */
  lineIndex?: number;
  productId: string;
  variantId: string | null;
  warehouseId: string;
  warehouseCode: string;
  quantity: number;
}

interface WarehouseRow {
  id: string;
  code: string;
}

function activeWarehouses(db: SyncSql, storeId: string): WarehouseRow[] {
  return db.all(
    'SELECT id, code FROM warehouses WHERE store_id = ? AND is_active = 1 ORDER BY priority DESC, code ASC',
    [storeId]
  ) as unknown as WarehouseRow[];
}

const rowQty = (
  db: SyncSql,
  storeId: string,
  warehouseId: string,
  productId: string,
  variantId: string | null
): number =>
  (db.all(
    variantId
      ? 'SELECT quantity FROM warehouse_stock WHERE store_id = ? AND warehouse_id = ? AND product_id = ? AND variant_id = ?'
      : 'SELECT quantity FROM warehouse_stock WHERE store_id = ? AND warehouse_id = ? AND product_id = ? AND variant_id IS NULL',
    variantId ? [storeId, warehouseId, productId, variantId] : [storeId, warehouseId, productId]
  )[0]?.quantity as number | undefined) ?? 0;

interface RoutePlan {
  /** where the line's units come from, in priority order: one entry when a warehouse holds the whole line, else a greedy split */
  chunks: Array<{ warehouse: WarehouseRow; quantity: number }>;
}

/**
 * BEFORE the aggregate decrement. null = this store is not routed (fewer than 2 active warehouses): do nothing else.
 * Reconciles the SKU's shadow to the aggregate first so a drifted shadow cannot hide stock the aggregate really has.
 */
export function planRoute(
  db: SyncSql,
  storeId: string,
  productId: string,
  variantId: string | null,
  qty: number
): RoutePlan | null {
  const whs = activeWarehouses(db, storeId);
  if (whs.length < 2) return null;
  reconcileToAggregate(db, storeId, productId, variantId);
  const held = whs.map(w => ({ w, q: rowQty(db, storeId, w.id, productId, variantId) }));
  // Ruling WAREHOUSE-ROUTE-3: the whole line from one warehouse when any can; otherwise split greedily by priority
  const whole = held.find(h => h.q >= qty);
  if (whole) return { chunks: [{ warehouse: whole.w, quantity: qty }] };
  const chunks: RoutePlan['chunks'] = [];
  let remaining = qty;
  for (const h of held) {
    if (remaining <= 0) break;
    const n = Math.min(Math.max(0, h.q), remaining);
    if (n > 0) chunks.push({ warehouse: h.w, quantity: n });
    remaining -= n;
  }
  return { chunks };
}

/** Override lines skip routing, so bring their shadow to the aggregate right after the take (routed stores only). */
export function reconcileOverrideSku(
  db: SyncSql,
  storeId: string,
  productId: string,
  variantId: string | null
): void {
  if (activeWarehouses(db, storeId).length >= 2)
    reconcileToAggregate(db, storeId, productId, variantId);
}

/**
 * AFTER the aggregate decrement succeeded for the whole `qty`: move the same units out of the chosen warehouse(s), one
 * allocation per chunk. If the rows held less than the aggregate (drift the reconcile could not fix) the uncovered units are
 * left to a reconcile, which lands the difference on the default warehouse (Ruling WAREHOUSE-ROUTE-2); it never throws.
 */
export function applyRoute(
  db: SyncSql,
  storeId: string,
  plan: RoutePlan,
  productId: string,
  variantId: string | null,
  qty: number,
  ref: { lineIndex?: number; orderItemId?: string }
): Allocation[] {
  let covered = 0;
  const out: Allocation[] = [];
  for (const c of plan.chunks) {
    upsertWarehouseStock(db, {
      storeId,
      warehouseId: c.warehouse.id,
      productId,
      variantId,
      mode: 'shift',
      value: -c.quantity,
    });
    covered += c.quantity;
    out.push({
      ...ref,
      productId,
      variantId,
      warehouseId: c.warehouse.id,
      warehouseCode: c.warehouse.code,
      quantity: c.quantity,
    });
  }
  if (covered < qty) reconcileToAggregate(db, storeId, productId, variantId);
  return out;
}

function writeEvent(
  db: SyncSql,
  storeId: string,
  orderId: string,
  toStatus: string,
  metadata: unknown,
  now: number
): void {
  db.run(
    'INSERT INTO order_events (id, store_id, order_id, from_status, to_status, actor_id, metadata, created_at) VALUES (?, ?, ?, NULL, ?, NULL, ?, ?)',
    [crypto.randomUUID(), storeId, orderId, toStatus, JSON.stringify(metadata), now]
  );
}

/** Persist the allocations of a freshly placed order (call once the order row exists). No allocations -> no event. */
export function recordAllocations(
  db: SyncSql,
  storeId: string,
  orderId: string,
  allocations: Allocation[],
  now: number,
  itemIds: string[] = []
): void {
  if (allocations.length === 0) return;
  const resolved = allocations.map(({ lineIndex, ...a }) => ({
    ...a,
    orderItemId: a.orderItemId ?? (lineIndex === undefined ? undefined : itemIds[lineIndex]),
  }));
  writeEvent(db, storeId, orderId, ALLOCATED_EVENT, { allocations: resolved }, now);
}

function eventsOf(db: SyncSql, storeId: string, orderId: string, type: string): Allocation[][] {
  const out: Allocation[][] = [];
  for (const e of db.all(
    'SELECT metadata FROM order_events WHERE store_id = ? AND order_id = ? AND to_status = ? ORDER BY created_at ASC, rowid ASC',
    [storeId, orderId, type]
  )) {
    try {
      const m = JSON.parse(String(e.metadata)) as { allocations?: Allocation[] };
      if (Array.isArray(m.allocations)) out.push(m.allocations);
    } catch {
      /* a malformed marker gives nothing back; the reconcile sweep restores the sum */
    }
  }
  return out;
}

/** What the order took from each warehouse for ONE ORDER LINE, minus what was already given back, lowest priority first. */
function outstanding(
  db: SyncSql,
  storeId: string,
  orderId: string,
  orderItemId: string
): Array<{ warehouseId: string; quantity: number }> {
  const left = new Map<string, number>();
  const sign = (list: Allocation[][], dir: 1 | -1) => {
    for (const alloc of list)
      for (const a of alloc) {
        if (a.orderItemId !== orderItemId) continue;
        left.set(a.warehouseId, (left.get(a.warehouseId) ?? 0) + dir * a.quantity);
      }
  };
  sign(eventsOf(db, storeId, orderId, ALLOCATED_EVENT), 1);
  sign(eventsOf(db, storeId, orderId, RELEASED_EVENT), -1);
  // allocation order is priority order; a give-back walks it backwards (the last chunk taken is the first returned)
  return [...left]
    .filter(([, q]) => q > 0)
    .map(([warehouseId, quantity]) => ({ warehouseId, quantity }))
    .reverse();
}

/**
 * Put `qty` units of one SKU back into the warehouse(s) the order took them from (cancel / refund / return). Call AFTER the
 * aggregate was restocked. An order with no allocation (single-warehouse store, legacy order, backorder units) gives nothing
 * back here, exactly as before.
 */
export function releaseToWarehouses(
  db: SyncSql,
  storeId: string,
  orderId: string,
  orderItemId: string,
  productId: string,
  variantId: string | null,
  qty: number,
  now: number
): void {
  let todo = qty;
  const given: Allocation[] = [];
  for (const o of outstanding(db, storeId, orderId, orderItemId)) {
    if (todo <= 0) break;
    const wh = db.all('SELECT code FROM warehouses WHERE id = ? AND store_id = ?', [
      o.warehouseId,
      storeId,
    ])[0];
    if (!wh) continue; // the warehouse was deleted since: its rows are gone, the reconcile sweep re-attributes the units
    const n = Math.min(todo, o.quantity);
    upsertWarehouseStock(db, {
      storeId,
      warehouseId: o.warehouseId,
      productId,
      variantId,
      mode: 'shift',
      value: n,
    });
    given.push({
      orderItemId,
      productId,
      variantId,
      warehouseId: o.warehouseId,
      warehouseCode: wh.code as string,
      quantity: n,
    });
    todo -= n;
  }
  // Units this line never had allocated (an order from before routing, an overridden phone order, backorder units) were
  // restocked on the aggregate only: bring the shadow back to it, the surplus landing on the default warehouse (the
  // reconcile rule). Only in a routed store; a single / no-warehouse store keeps its exact old behaviour.
  if (todo > 0 && activeWarehouses(db, storeId).length >= 2)
    reconcileToAggregate(db, storeId, productId, variantId);
  if (given.length > 0)
    writeEvent(db, storeId, orderId, RELEASED_EVENT, { allocations: given }, now);
}
