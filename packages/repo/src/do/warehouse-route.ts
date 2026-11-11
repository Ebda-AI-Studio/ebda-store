import { MoneyError, type SyncSql } from './sync-sql';
import { reconcileToAggregate, upsertWarehouseStock } from './stock-ops';

/**
 * Ruling WAREHOUSE-ROUTE-1: order creation routes each stock line to ONE warehouse, in the same StoreDO section as the order.
 *
 * `Product.inventory` / `ProductVariant.inventory` stays the authoritative, oversell-guarded number (checkout is unchanged);
 * the warehouse rows are the per-location shadow whose SUM equals it. Routing keeps that invariant: the SKU's shadow is first
 * reconciled to the aggregate (a no-op when already equal), the line goes to the best warehouse that can fulfil the WHOLE line
 * (priority desc, code asc: the rule of `WarehouseService.routeOrder`), the aggregate is decremented as before and the chosen
 * warehouse row is decremented by the same quantity. No single warehouse can fulfil it -> 409 NO_SINGLE_WAREHOUSE and the
 * section rolls back (never an oversell, never a partial). The allocation is stored as an order event `warehouse_allocated`;
 * a cancel / refund / partial return reads it and puts the units back into the SAME warehouse (`warehouse_released` events
 * keep what was already given back, so a second return never returns more than was taken).
 *
 * A store with fewer than 2 active warehouses is NOT routed at all: `planRoute` returns null and every statement is exactly
 * what it was before this file existed (single / no-warehouse stores keep byte-identical stock math).
 */
export const ALLOCATED_EVENT = 'warehouse_allocated';
export const RELEASED_EVENT = 'warehouse_released';

export interface Allocation {
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

export interface RoutePlan {
  /** the warehouse that can fulfil the whole line, or null when none can (the caller refuses once the aggregate is taken) */
  chosen: WarehouseRow | null;
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
  const chosen = whs.find(w => rowQty(db, storeId, w.id, productId, variantId) >= qty) ?? null;
  return { chosen };
}

/** AFTER the aggregate decrement succeeded for the whole `qty`: move the same units out of the chosen warehouse. */
export function applyRoute(
  db: SyncSql,
  storeId: string,
  plan: RoutePlan,
  productId: string,
  variantId: string | null,
  qty: number
): Allocation {
  if (!plan.chosen)
    throw new MoneyError(
      'NO_SINGLE_WAREHOUSE',
      'no single warehouse holds enough stock for this line',
      409,
      { productId, variantId, requested: qty }
    );
  upsertWarehouseStock(db, {
    storeId,
    warehouseId: plan.chosen.id,
    productId,
    variantId,
    mode: 'shift',
    value: -qty,
  });
  return {
    productId,
    variantId,
    warehouseId: plan.chosen.id,
    warehouseCode: plan.chosen.code,
    quantity: qty,
  };
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
  now: number
): void {
  if (allocations.length === 0) return;
  writeEvent(db, storeId, orderId, ALLOCATED_EVENT, { allocations }, now);
}

const skuKey = (p: string, v: string | null) => `${p}|${v ?? ''}`;

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

/** What the order took from each warehouse for one SKU, minus what was already given back. */
function outstanding(
  db: SyncSql,
  storeId: string,
  orderId: string,
  productId: string,
  variantId: string | null
): Array<{ warehouseId: string; quantity: number }> {
  const key = skuKey(productId, variantId);
  const left = new Map<string, number>();
  const sign = (list: Allocation[][], dir: 1 | -1) => {
    for (const alloc of list)
      for (const a of alloc) {
        if (skuKey(a.productId, a.variantId ?? null) !== key) continue;
        left.set(a.warehouseId, (left.get(a.warehouseId) ?? 0) + dir * a.quantity);
      }
  };
  sign(eventsOf(db, storeId, orderId, ALLOCATED_EVENT), 1);
  sign(eventsOf(db, storeId, orderId, RELEASED_EVENT), -1);
  return [...left]
    .filter(([, q]) => q > 0)
    .map(([warehouseId, quantity]) => ({ warehouseId, quantity }));
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
  productId: string,
  variantId: string | null,
  qty: number,
  now: number
): void {
  let todo = qty;
  const given: Allocation[] = [];
  for (const o of outstanding(db, storeId, orderId, productId, variantId)) {
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
      productId,
      variantId,
      warehouseId: o.warehouseId,
      warehouseCode: wh.code as string,
      quantity: n,
    });
    todo -= n;
  }
  if (given.length > 0)
    writeEvent(db, storeId, orderId, RELEASED_EVENT, { allocations: given }, now);
}
