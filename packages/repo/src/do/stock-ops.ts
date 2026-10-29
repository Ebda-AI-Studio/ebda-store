import { MoneyError, type SyncSql } from './sync-sql';

/**
 * Stock and inventory on the StoreDO (INFRA-CF-1 PR D2a, Ruling CF-STOCK-1; plan section 4 rows 1, 2, 6).
 *
 * One exported operation per admin stock write. Each runs as ONE `transactionSync` section, so the read, the check and
 * the write cannot be separated by another request (the DO is single threaded): no row lock is needed where Postgres used
 * `FOR UPDATE`. An operation may carry an idempotency key; the first run stores its result under the key IN THE SAME
 * section (`_stock_ops`), a replay returns it without touching a row, and the same key for other arguments is refused.
 *
 * Semantics are the ones of the Postgres services (`InventoryService`, `VariantService.bulkUpdateInventory`,
 * `WarehouseService.setStock/adjustStock/reconcileWarehouseStockToAggregate`): same error codes and statuses, same
 * history rows, same quantities. The one deliberate difference: the warehouse shadow re-sync that the Postgres services
 * run best-effort AFTER commit runs here INSIDE the section, so the aggregate and the shadow move together or not at all.
 */
export type StockOpName =
  | 'adjustProduct'
  | 'setProduct'
  | 'bulkAdjustProducts'
  | 'setVariantInventory'
  | 'setWarehouseStock'
  | 'adjustWarehouseStock';

export const STOCK_OP_NAMES: readonly StockOpName[] = [
  'adjustProduct',
  'setProduct',
  'bulkAdjustProducts',
  'setVariantInventory',
  'setWarehouseStock',
  'adjustWarehouseStock',
];

type HistoryType =
  | 'manual_add'
  | 'manual_remove'
  | 'sale'
  | 'return_stock'
  | 'adjustment'
  | 'damage'
  | 'transfer_in'
  | 'transfer_out'
  | 'initial';
const HISTORY_TYPES: ReadonlySet<string> = new Set([
  'manual_add',
  'manual_remove',
  'sale',
  'return_stock',
  'adjustment',
  'damage',
  'transfer_in',
  'transfer_out',
  'initial',
]);

const KEY_RE = /^[A-Za-z0-9._:-]{8,128}$/;
const KEY_TTL_MS = 24 * 60 * 60 * 1000;
const INT4_MAX = 2147483647;

export function ensureStockOpsSchema(db: SyncSql): void {
  db.run(
    'CREATE TABLE IF NOT EXISTS _stock_ops (k TEXT PRIMARY KEY, op TEXT NOT NULL, fp TEXT NOT NULL, result TEXT NOT NULL, at INTEGER NOT NULL)',
    []
  );
}

const fail = (code: string, message: string, status = 400): never => {
  throw new MoneyError(code, message, status);
};
const str = (v: unknown, what: string): string =>
  typeof v === 'string' && v.length > 0 && v.length <= 128 ? v : fail('BAD_ARGS', what);
const int = (v: unknown, what: string, min = -INT4_MAX, max = INT4_MAX): number =>
  typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max ? v : fail('BAD_ARGS', what);
const optStr = (v: unknown, what: string, max = 500): string | null =>
  v === undefined || v === null
    ? null
    : typeof v === 'string' && v.length <= max
      ? v
      : fail('BAD_ARGS', what);
const hType = (v: unknown): HistoryType =>
  typeof v === 'string' && HISTORY_TYPES.has(v) ? (v as HistoryType) : fail('BAD_ARGS', 'type');

function fingerprint(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193) >>> 0;
  return `${s.length}:${h.toString(16)}`;
}

function history(
  db: SyncSql,
  m: {
    storeId: string;
    productId: string;
    type: HistoryType;
    quantity: number;
    previousStock: number;
    newStock: number;
    reason: string | null;
    reference: string | null;
    createdBy: string | null;
  }
): string {
  const id = crypto.randomUUID();
  db.run(
    'INSERT INTO inventory_history (id, product_id, store_id, type, quantity, previous_stock, new_stock, reason, reference, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [
      id,
      m.productId,
      m.storeId,
      m.type,
      m.quantity,
      m.previousStock,
      m.newStock,
      m.reason,
      m.reference,
      m.createdBy,
    ]
  );
  return id;
}

interface ProductRow {
  id: string;
  name: string;
  inventory: number;
}
const product = (db: SyncSql, storeId: string, productId: string): ProductRow | undefined =>
  db.all(
    'SELECT id, name, inventory FROM products WHERE id = ? AND store_id = ? AND deleted_at IS NULL',
    [productId, storeId]
  )[0] as ProductRow | undefined;
const variantCount = (db: SyncSql, productId: string): number =>
  db.all('SELECT count(*) AS n FROM product_variants WHERE product_id = ?', [productId])[0]
    .n as number;

/** Warehouse upsert: the base-product row (variant NULL) and a variant row conflict on different unique indexes. */
function upsertWarehouseStock(
  db: SyncSql,
  a: {
    storeId: string;
    warehouseId: string;
    productId: string;
    variantId: string | null;
    mode: 'set' | 'add' | 'shift';
    value: number;
  }
): number {
  // 'add' floors at 0 (WarehouseService.adjustStock: GREATEST(0, qty + delta)); 'shift' is the reconcile's unfloored
  // `qty + diff` (Postgres can drive the default warehouse row negative there; replicated for parity, see CF-STOCK-1)
  const set =
    a.mode === 'set'
      ? 'excluded.quantity'
      : a.mode === 'add'
        ? 'MAX(0, warehouse_stock.quantity + ?)'
        : 'warehouse_stock.quantity + ?';
  const initial = a.mode === 'add' ? Math.max(0, a.value) : a.value;
  const target =
    a.variantId === null
      ? 'ON CONFLICT (warehouse_id, product_id) WHERE variant_id IS NULL'
      : 'ON CONFLICT (warehouse_id, product_id, variant_id)';
  const rows = db.all(
    `INSERT INTO warehouse_stock (id, warehouse_id, product_id, variant_id, quantity, store_id) VALUES (?, ?, ?, ?, ?, ?) ${target} DO UPDATE SET quantity = ${set}, updated_at = CAST(unixepoch('subsec') * 1000 AS INTEGER) RETURNING quantity`,
    [
      crypto.randomUUID(),
      a.warehouseId,
      a.productId,
      a.variantId,
      initial,
      a.storeId,
      ...(a.mode === 'set' ? [] : [a.value]),
    ]
  );
  return rows[0].quantity as number;
}

/** products.inventory / product_variants.inventory := SUM of the warehouse rows (what `syncAggregateInventory` does). */
function syncAggregate(
  db: SyncSql,
  storeId: string,
  productId: string,
  variantId: string | null
): void {
  if (variantId)
    db.run(
      `UPDATE product_variants SET inventory = (SELECT COALESCE(SUM(quantity), 0) FROM warehouse_stock WHERE store_id = ? AND product_id = ? AND variant_id = ?) WHERE id = ? AND product_id = ? AND EXISTS (SELECT 1 FROM products p WHERE p.id = ? AND p.store_id = ?)`,
      [storeId, productId, variantId, variantId, productId, productId, storeId]
    );
  else
    db.run(
      `UPDATE products SET inventory = (SELECT COALESCE(SUM(quantity), 0) FROM warehouse_stock WHERE store_id = ? AND product_id = ? AND variant_id IS NULL) WHERE id = ? AND store_id = ?`,
      [storeId, productId, productId, storeId]
    );
}

/** The store's default warehouse, in the order `WarehouseService.resolveDefaultWarehouse` uses. */
function defaultWarehouse(db: SyncSql, storeId: string): string | null {
  const rows = db.all(
    'SELECT id, is_default, priority, is_active FROM warehouses WHERE store_id = ? ORDER BY created_at ASC, rowid ASC',
    [storeId]
  );
  if (rows.length === 0) return null;
  const explicit = rows.find(w => w.is_default === 1);
  if (explicit) return explicit.id as string;
  const active = rows
    .filter(w => w.is_active === 1)
    .sort((a, b) => (b.priority as number) - (a.priority as number))[0];
  return (active ?? rows[0]).id as string;
}

/** Shift the default warehouse's row so the shadow sums to the aggregate that was just written. */
function reconcileToAggregate(
  db: SyncSql,
  storeId: string,
  productId: string,
  variantId: string | null
): void {
  const wh = defaultWarehouse(db, storeId);
  if (!wh) return;
  const authoritative = (
    variantId
      ? db.all('SELECT inventory FROM product_variants WHERE id = ?', [variantId])
      : db.all('SELECT inventory FROM products WHERE id = ? AND store_id = ?', [productId, storeId])
  )[0]?.inventory as number | undefined;
  if (authoritative === undefined)
    fail(
      variantId ? 'VARIANT_NOT_FOUND' : 'PRODUCT_NOT_FOUND',
      variantId ? 'Variant not found' : 'Product not found',
      404
    );
  const sum = db.all(
    variantId
      ? 'SELECT COALESCE(SUM(quantity), 0) AS s FROM warehouse_stock WHERE store_id = ? AND product_id = ? AND variant_id = ?'
      : 'SELECT COALESCE(SUM(quantity), 0) AS s FROM warehouse_stock WHERE store_id = ? AND product_id = ? AND variant_id IS NULL',
    variantId ? [storeId, productId, variantId] : [storeId, productId]
  )[0].s as number;
  const diff = (authoritative as number) - sum;
  if (diff === 0) return;
  upsertWarehouseStock(db, {
    storeId,
    warehouseId: wh,
    productId,
    variantId,
    mode: 'shift',
    value: diff,
  });
}

// ---------------------------------------------------------------------------------------------------------------------

/** InventoryService.adjustInventory: add `quantity` (signed) to a product's stock and record why. */
function adjustProduct(db: SyncSql, storeId: string, a: Record<string, unknown>) {
  const productId = str(a.productId, 'productId');
  const quantity = int(a.quantity, 'quantity');
  const type = hType(a.type);
  const p = product(db, storeId, productId);
  if (!p) return fail('NOT_FOUND', 'Product not found', 404);
  if (variantCount(db, productId) > 0)
    return fail(
      'VARIANT_PRODUCT',
      'This product tracks stock on its variants. Adjust the variant inventory instead.'
    );
  const previousStock = p.inventory;
  const newStock = previousStock + quantity;
  if (newStock < 0) return fail('INSUFFICIENT_STOCK', 'Cannot reduce stock below zero');
  if (newStock > INT4_MAX) return fail('BAD_ARGS', 'stock overflow');
  db.run('UPDATE products SET inventory = ? WHERE id = ? AND store_id = ?', [
    newStock,
    productId,
    storeId,
  ]);
  const historyId = history(db, {
    storeId,
    productId,
    type,
    quantity,
    previousStock,
    newStock,
    reason: optStr(a.reason, 'reason'),
    reference: optStr(a.reference, 'reference'),
    createdBy: optStr(a.userId, 'userId', 128),
  });
  reconcileToAggregate(db, storeId, productId, null);
  return { productId, name: p.name, previousStock, newStock, historyId };
}

/** InventoryService.setInventory: stock count, absolute value. */
function setProduct(db: SyncSql, storeId: string, a: Record<string, unknown>) {
  const productId = str(a.productId, 'productId');
  const newStock = int(a.quantity, 'quantity', 0);
  const p = product(db, storeId, productId);
  if (!p) return fail('NOT_FOUND', 'Product not found', 404);
  const previousStock = p.inventory;
  db.run('UPDATE products SET inventory = ? WHERE id = ? AND store_id = ?', [
    newStock,
    productId,
    storeId,
  ]);
  const historyId = history(db, {
    storeId,
    productId,
    type: 'adjustment',
    quantity: newStock - previousStock,
    previousStock,
    newStock,
    reason: optStr(a.reason, 'reason') || 'Inventory count adjustment',
    reference: null,
    createdBy: optStr(a.userId, 'userId', 128),
  });
  reconcileToAggregate(db, storeId, productId, null);
  return { productId, name: p.name, previousStock, newStock, historyId };
}

/** InventoryService.bulkAdjustInventory: a bad row fails alone (planned from the state at the start), the rest apply together. */
function bulkAdjustProducts(db: SyncSql, storeId: string, a: Record<string, unknown>) {
  if (!Array.isArray(a.adjustments) || a.adjustments.length > 500)
    return fail('BAD_ARGS', 'adjustments');
  const userId = optStr(a.userId, 'userId', 128);
  const errors: string[] = [];
  let failed = 0;
  const plans: Array<{
    productId: string;
    name: string;
    previousStock: number;
    newStock: number;
    quantity: number;
    type: HistoryType;
    reason: string | null;
    reference: string | null;
  }> = [];
  const seen = new Map<string, ProductRow & { hasVariants: boolean }>();
  for (const raw of a.adjustments as Array<Record<string, unknown>>) {
    const productId = str(raw.productId, 'productId');
    const quantity = int(raw.quantity, 'quantity');
    const type = hType(raw.type);
    let p = seen.get(productId);
    if (!p) {
      const row = product(db, storeId, productId);
      if (row) {
        p = { ...row, hasVariants: variantCount(db, productId) > 0 };
        seen.set(productId, p);
      }
    }
    if (!p) {
      failed++;
      errors.push(`Product ${productId}: NOT_FOUND`);
      continue;
    }
    if (p.hasVariants) {
      failed++;
      errors.push(`${p.name}: tracks stock on its variants — adjust the variant inventory instead`);
      continue;
    }
    const newStock = p.inventory + quantity;
    if (newStock < 0 || newStock > INT4_MAX) {
      failed++;
      errors.push(`Product ${productId}: INSUFFICIENT_STOCK`);
      continue;
    }
    plans.push({
      productId,
      name: p.name,
      previousStock: p.inventory,
      newStock,
      quantity,
      type,
      reason: optStr(raw.reason, 'reason'),
      reference: optStr(raw.reference, 'reference'),
    });
  }
  for (const p of plans) {
    db.run('UPDATE products SET inventory = ? WHERE id = ? AND store_id = ?', [
      p.newStock,
      p.productId,
      storeId,
    ]);
    history(db, {
      storeId,
      productId: p.productId,
      type: p.type,
      quantity: p.quantity,
      previousStock: p.previousStock,
      newStock: p.newStock,
      reason: p.reason,
      reference: p.reference,
      createdBy: userId,
    });
  }
  // no shadow re-sync: the Postgres bulk path does not do one either (recorded in CF-STOCK-1)
  return {
    successful: plans.length,
    failed,
    errors,
    applied: plans.map(p => ({
      productId: p.productId,
      name: p.name,
      previousStock: p.previousStock,
      newStock: p.newStock,
    })),
  };
}

/** VariantService.bulkUpdateInventory: absolute stock per variant of one product; an unknown variant fails alone. */
function setVariantInventory(db: SyncSql, storeId: string, a: Record<string, unknown>) {
  const productId = str(a.productId, 'productId');
  if (!Array.isArray(a.updates) || a.updates.length > 500) return fail('BAD_ARGS', 'updates');
  if (!product(db, storeId, productId)) return fail('NOT_FOUND', 'Product not found', 404);
  const results: Array<{ variantId: string; success: boolean }> = [];
  for (const u of a.updates as Array<Record<string, unknown>>) {
    const variantId = str(u.variantId, 'variantId');
    const inventory = int(u.inventory, 'inventory', 0);
    const r = db.run('UPDATE product_variants SET inventory = ? WHERE id = ? AND product_id = ?', [
      inventory,
      variantId,
      productId,
    ]);
    results.push({ variantId, success: r.changes === 1 });
  }
  return {
    updated: results.filter(r => r.success).length,
    failed: results.filter(r => !r.success).length,
    results,
  };
}

function warehouseTarget(db: SyncSql, storeId: string, a: Record<string, unknown>) {
  const warehouseId = str(a.warehouseId, 'warehouseId');
  const productId = str(a.productId, 'productId');
  const variantId =
    a.variantId === undefined || a.variantId === null ? null : str(a.variantId, 'variantId');
  const wh = db.all('SELECT id, code FROM warehouses WHERE id = ? AND store_id = ?', [
    warehouseId,
    storeId,
  ])[0];
  if (!wh) return fail('WAREHOUSE_NOT_FOUND', 'Warehouse not found', 404);
  if (!product(db, storeId, productId)) return fail('PRODUCT_NOT_FOUND', 'Product not found', 404);
  if (!variantId && variantCount(db, productId) > 0)
    return fail(
      'VARIANT_PRODUCT',
      'This product tracks stock on its variants. Set the warehouse stock per variant instead.'
    );
  if (
    variantId &&
    db.all('SELECT 1 AS x FROM product_variants WHERE id = ? AND product_id = ?', [
      variantId,
      productId,
    ]).length === 0
  )
    return fail('VARIANT_NOT_FOUND', 'Variant not found', 404);
  return { warehouseId, productId, variantId, code: wh.code as string };
}

/** WarehouseService.setStock */
function setWarehouseStock(db: SyncSql, storeId: string, a: Record<string, unknown>) {
  const quantity = int(a.quantity, 'quantity');
  if (quantity < 0) return fail('INVALID_QUANTITY', 'Quantity cannot be negative');
  const t = warehouseTarget(db, storeId, a);
  const q = upsertWarehouseStock(db, { storeId, ...t, mode: 'set', value: quantity });
  syncAggregate(db, storeId, t.productId, t.variantId);
  return { quantity: q };
}

/** WarehouseService.adjustStock: signed delta, floored at 0, with an audit row. */
function adjustWarehouseStock(db: SyncSql, storeId: string, a: Record<string, unknown>) {
  const delta = int(a.delta, 'delta');
  const t = warehouseTarget(db, storeId, a);
  const before = db.all(
    t.variantId
      ? 'SELECT quantity FROM warehouse_stock WHERE store_id = ? AND warehouse_id = ? AND product_id = ? AND variant_id = ?'
      : 'SELECT quantity FROM warehouse_stock WHERE store_id = ? AND warehouse_id = ? AND product_id = ? AND variant_id IS NULL',
    t.variantId
      ? [storeId, t.warehouseId, t.productId, t.variantId]
      : [storeId, t.warehouseId, t.productId]
  )[0];
  const previousQty = (before?.quantity as number | undefined) ?? 0;
  const newQty = upsertWarehouseStock(db, { storeId, ...t, mode: 'add', value: delta });
  syncAggregate(db, storeId, t.productId, t.variantId);
  const reason = optStr(a.reason, 'reason');
  history(db, {
    storeId,
    productId: t.productId,
    type: delta >= 0 ? 'manual_add' : 'manual_remove',
    quantity: delta,
    previousStock: previousQty,
    newStock: newQty,
    reason: reason ? `[Warehouse: ${t.code}] ${reason}` : `[Warehouse: ${t.code}] delta adjustment`,
    reference: t.warehouseId,
    createdBy: null,
  });
  return { newQuantity: newQty };
}

const OPS: Record<
  StockOpName,
  (db: SyncSql, storeId: string, a: Record<string, unknown>) => unknown
> = {
  adjustProduct,
  setProduct,
  bulkAdjustProducts,
  setVariantInventory,
  setWarehouseStock,
  adjustWarehouseStock,
};

/**
 * Run one stock operation for `storeId`. THROWS `MoneyError` for a refusal (the DO wrapper turns it into an answer);
 * everything it wrote is rolled back with it. `now` is injectable for the key-expiry test.
 */
export function runStockOp(
  db: SyncSql,
  storeId: string,
  op: string,
  args: unknown,
  key?: string,
  now: () => number = Date.now
): unknown {
  if (!Object.prototype.hasOwnProperty.call(OPS, op))
    throw new MoneyError('STOCK_OP_NOT_ALLOWED', `stock operation ${op}`, 400);
  if (!args || typeof args !== 'object' || Array.isArray(args))
    throw new MoneyError('BAD_ARGS', 'args', 400);
  if (key !== undefined && !KEY_RE.test(key))
    throw new MoneyError('BAD_IDEMPOTENCY_KEY', 'key', 400);
  const fp = fingerprint(`${op}:${JSON.stringify(args)}`);
  return db.transactionSync(() => {
    if (key) {
      const prior = db.all('SELECT op, fp, result, at FROM _stock_ops WHERE k = ?', [key])[0];
      if (prior && (prior.at as number) > now() - KEY_TTL_MS) {
        if (prior.fp !== fp)
          throw new MoneyError('IDEMPOTENCY_KEY_REUSED', 'key used for another operation', 409);
        return JSON.parse(prior.result as string);
      }
      if (prior) db.run('DELETE FROM _stock_ops WHERE k = ?', [key]);
    }
    const out = OPS[op as StockOpName](db, storeId, args as Record<string, unknown>);
    if (key) {
      db.run('DELETE FROM _stock_ops WHERE at < ?', [now() - KEY_TTL_MS]);
      db.run('INSERT INTO _stock_ops (k, op, fp, result, at) VALUES (?, ?, ?, ?, ?)', [
        key,
        op,
        fp,
        JSON.stringify(out),
        now(),
      ]);
    }
    return out;
  });
}
