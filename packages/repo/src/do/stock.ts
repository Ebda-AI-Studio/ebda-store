import { MoneyError, type SyncSql } from './sync-sql';

/**
 * Stock on the StoreDO (plan section 4 rows 1, 2, 6, 7: `StoreDO.stock.*`). Every method is one conditional
 * statement, so the check and the write cannot be separated; callers run them inside `transactionSync`.
 * Rule (docs/architecture/inventory-model.md): a line decrements the VARIANT row XOR the PRODUCT row, never both,
 * and no column ever stores a negative number (the schema also has no CHECK on it, so these guards ARE the invariant).
 */
export interface StockResult {
  ok: boolean;
  previousStock: number;
  newStock: number;
}

function guarded(
  db: SyncSql,
  table: 'products' | 'product_variants',
  id: string,
  qty: number
): StockResult {
  if (!Number.isInteger(qty) || qty < 1 || qty > 100_000)
    throw new MoneyError('BAD_QUANTITY', 'quantity must be an integer from 1 to 100000', 400);
  const rows = db.all(
    `UPDATE ${table} SET inventory = inventory - ?1 WHERE id = ?2 AND inventory >= ?1 RETURNING inventory`,
    [qty, id]
  );
  if (rows.length === 1) {
    const n = rows[0].inventory as number;
    return { ok: true, previousStock: n + qty, newStock: n };
  }
  const cur = db.all(`SELECT inventory FROM ${table} WHERE id = ?`, [id])[0]?.inventory as
    | number
    | undefined;
  return { ok: false, previousStock: cur ?? 0, newStock: cur ?? 0 };
}

/** Conditional decrement: `ok:false` means the stock was not enough and NOTHING changed. */
export const decrementProduct = (db: SyncSql, productId: string, qty: number): StockResult =>
  guarded(db, 'products', productId, qty);
export const decrementVariant = (db: SyncSql, variantId: string, qty: number): StockResult =>
  guarded(db, 'product_variants', variantId, qty);

/** Backorder path: floored at 0 so the column never stores a negative; reports the REAL pre-decrement stock. */
export function forceDecrementVariant(db: SyncSql, variantId: string, qty: number): StockResult {
  if (!Number.isInteger(qty) || qty < 1 || qty > 100_000)
    throw new MoneyError('BAD_QUANTITY', 'quantity must be an integer from 1 to 100000', 400);
  const cur = db.all('SELECT inventory FROM product_variants WHERE id = ?', [variantId])[0]
    ?.inventory as number | undefined;
  if (cur === undefined) throw new MoneyError('VARIANT_NOT_FOUND', 'variant not found', 404);
  const n = Math.max(0, cur - qty);
  db.run('UPDATE product_variants SET inventory = ?1 WHERE id = ?2', [n, variantId]);
  return { ok: true, previousStock: cur, newStock: n };
}

/** Restock (cancel / refund / return): unconditional add, bounded so a bug cannot overflow int4. */
export function restock(
  db: SyncSql,
  table: 'products' | 'product_variants',
  id: string,
  qty: number
): StockResult {
  if (!Number.isInteger(qty) || qty < 1 || qty > 100_000)
    throw new MoneyError('BAD_QUANTITY', 'quantity must be an integer from 1 to 100000', 400);
  const rows = db.all(
    `UPDATE ${table} SET inventory = inventory + ? WHERE id = ? AND inventory + ? <= 2147483647 RETURNING inventory`,
    [qty, id, qty]
  );
  if (rows.length !== 1)
    throw new MoneyError('RESTOCK_REFUSED', 'row missing or the stock would overflow', 409);
  const n = rows[0].inventory as number;
  return { ok: true, previousStock: n - qty, newStock: n };
}

/** Append a stock ledger row (inventory_history). `type` is the InventoryChangeType enum. */
export function recordMovement(
  db: SyncSql,
  m: {
    storeId: string;
    productId: string;
    type: 'sale' | 'return_stock' | 'adjustment' | 'manual_add' | 'manual_remove';
    quantity: number;
    previousStock: number;
    newStock: number;
    reason?: string;
    reference?: string;
  }
): void {
  db.run(
    'INSERT INTO inventory_history (id, product_id, store_id, type, quantity, previous_stock, new_stock, reason, reference) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [
      crypto.randomUUID(),
      m.productId,
      m.storeId,
      m.type,
      m.quantity,
      m.previousStock,
      m.newStock,
      m.reason ?? null,
      m.reference ?? null,
    ]
  );
}

/**
 * Takes UP TO `qty` units (never below 0, never raising a negative backorder debt) and reports what was ACTUALLY taken:
 * `previousStock - newStock`. The read and the clamped UPDATE run in one synchronous DO section (no await between them), so
 * the figure is exact; the phone-order override path books its ledger row and `stock_not_taken` marker from it.
 */
export function takeUpTo(
  db: SyncSql,
  table: 'products' | 'product_variants',
  id: string,
  qty: number
): StockResult {
  if (!Number.isInteger(qty) || qty < 1 || qty > 100_000)
    throw new MoneyError('BAD_QUANTITY', 'quantity must be an integer from 1 to 100000', 400);
  const cur = db.all(`SELECT inventory FROM ${table} WHERE id = ?`, [id])[0]?.inventory as
    | number
    | undefined;
  if (cur === undefined) throw new MoneyError('NOT_FOUND', 'stock row not found', 404);
  const rows = db.all(
    `UPDATE ${table} SET inventory = inventory - MIN(?1, MAX(inventory, 0)) WHERE id = ?2 RETURNING inventory`,
    [qty, id]
  );
  return { ok: true, previousStock: cur, newStock: rows[0].inventory as number };
}
