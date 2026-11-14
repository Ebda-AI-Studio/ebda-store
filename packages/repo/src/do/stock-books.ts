import { MoneyError, type SyncSql } from './sync-sql';
import { postEntry, systemAccountId } from './ledger';
import { reconcileToAggregate } from './stock-ops';

/**
 * The accounting and scan stock flows on the StoreDO (INFRA-CF-1 R7, Ruling CF-R7-1). They were `postgresOnly` in the flip
 * gate: purchase orders, stock adjustments, the opening-balance journal, scan-to-receive of a variant, count sessions and the
 * product bulk-update inventory field. Each is ONE `transactionSync` section (run by `runStockOp`, so it may carry an
 * idempotency key): the DO is single threaded, so the Postgres `FOR UPDATE` locks (the PO row, the products being received,
 * the draft being posted) are not needed - the check and the write cannot be separated by another request.
 *
 * Semantics are the ones of `purchase-order.service.ts`, `stock-adjustment.service.ts`, `account.service.ts`,
 * `barcode-scan.service.ts` and `ProductService.bulkUpdate`: same error codes and statuses, same history rows, same
 * quantities and costs. The difference that is deliberate: the warehouse shadow re-sync Postgres runs best-effort AFTER commit
 * runs INSIDE the section, so the aggregate and the shadow move together or not at all (as in CF-STOCK-1).
 */
const INT4_MAX = 2147483647;
type Args = Record<string, unknown>;
type Row = Record<string, unknown>;

const fail = (code: string, message: string, status = 400): never => {
  throw new MoneyError(code, message, status);
};
const str = (v: unknown, what: string): string =>
  typeof v === 'string' && v.length > 0 && v.length <= 128 ? v : fail('BAD_ARGS', what);
const optStr = (v: unknown, what: string, max = 2000): string | null =>
  v === undefined || v === null
    ? null
    : typeof v === 'string' && v.length <= max
      ? v
      : fail('BAD_ARGS', what);
const int = (v: unknown, what: string, min = -INT4_MAX, max = INT4_MAX): number =>
  typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max ? v : fail('BAD_ARGS', what);
const optMs = (v: unknown, what: string): number | null => {
  if (v === undefined || v === null) return null;
  if (v instanceof Date && Number.isFinite(v.getTime())) return v.getTime();
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  return fail('BAD_ARGS', what);
};
const list = (v: unknown, what: string, max = 5000): Args[] =>
  Array.isArray(v) && v.length <= max && v.every(x => x && typeof x === 'object')
    ? (v as Args[])
    : fail('BAD_ARGS', what);
const notFound = (): never =>
  fail('NOT_FOUND', 'One or more referenced records were not found', 404);

const history = (
  db: SyncSql,
  m: {
    storeId: string;
    productId: string;
    type: string;
    quantity: number;
    previousStock: number;
    newStock: number;
    reason: string | null;
    reference: string | null;
    createdBy: string | null;
  }
): void => {
  db.run(
    'INSERT INTO inventory_history (id, product_id, store_id, type, quantity, previous_stock, new_stock, reason, reference, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [
      crypto.randomUUID(),
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
};

/** `<PREFIX>-<year>-<6 digits>`: one statement claims the number, like `nextSequence` (INSERT ... ON CONFLICT ... RETURNING). */
function nextSequence(
  db: SyncSql,
  storeId: string,
  kind: 'po' | 'adjustment',
  now: number
): string {
  db.run(
    `INSERT INTO sequences (store_id, kind, next, updated_at) VALUES (?1, ?2, 2, ?3)
     ON CONFLICT (store_id, kind) DO UPDATE SET next = sequences.next + 1, updated_at = ?3`,
    [storeId, kind, now]
  );
  const n = db.all('SELECT next - 1 AS n FROM sequences WHERE store_id = ? AND kind = ?', [
    storeId,
    kind,
  ])[0].n as number;
  const prefix = kind === 'po' ? 'PO' : 'ADJ';
  return `${prefix}-${new Date(now).getUTCFullYear()}-${String(n).padStart(6, '0')}`;
}

const inList = (n: number) => Array.from({ length: n }, () => '?').join(', ');

/** assertStoreOwns: every id resolves inside the store, else 404 with no id named (a 403 would confirm it exists). */
function assertOwns(
  db: SyncSql,
  storeId: string,
  ids: { productIds?: string[]; variantIds?: string[]; supplierIds?: string[] }
): void {
  const uniq = (xs?: string[]) => [...new Set(xs ?? [])];
  const p = uniq(ids.productIds);
  const v = uniq(ids.variantIds);
  const s = uniq(ids.supplierIds);
  if (
    p.length &&
    (db.all(
      `SELECT count(*) AS n FROM products WHERE store_id = ? AND id IN (${inList(p.length)})`,
      [storeId, ...p]
    )[0].n as number) !== p.length
  )
    notFound();
  if (
    v.length &&
    (db.all(
      `SELECT count(*) AS n FROM product_variants v JOIN products p ON p.id = v.product_id WHERE p.store_id = ? AND v.id IN (${inList(v.length)})`,
      [storeId, ...v]
    )[0].n as number) !== v.length
  )
    notFound();
  if (
    s.length &&
    (db.all(
      `SELECT count(*) AS n FROM suppliers WHERE store_id = ? AND id IN (${inList(s.length)})`,
      [storeId, ...s]
    )[0].n as number) !== s.length
  )
    notFound();
}

const INVENTORY_TYPE: Record<string, string> = {
  cycle_count: 'adjustment',
  damage: 'damage',
  theft: 'damage',
  loss: 'damage',
  write_off: 'damage',
  found: 'manual_add',
  return_to_supplier: 'manual_remove',
};

// ---------------------------------------------------------------------------------------------------------------------
// Stock adjustments
// ---------------------------------------------------------------------------------------------------------------------

interface AdjItem {
  productId: string;
  variantId: string | null;
  newQty: number;
  /** a cycle-count line: the variance (counted - system at scan time) IS the intent, not `newQty - live now` (INV-AUDIT-1) */
  countDelta?: number;
}

/** createAdjustment: snapshot previous qty and unit cost per line, number the draft, insert it and its lines. */
function createAdjustmentIn(
  db: SyncSql,
  storeId: string,
  a: {
    type: string;
    reason: string | null;
    reasonAr: string | null;
    evidenceUrl: string | null;
    createdBy: string | null;
    importKey: string | null;
    items: AdjItem[];
    sessionId?: string | null;
  }
): { id: string; adjustmentNumber: string; status: string; itemCount: number } {
  if (!(a.type in INVENTORY_TYPE)) fail('BAD_ARGS', 'type');
  if (a.importKey) {
    // the CSV-import key is unique per store, like the Postgres index: a second create is REFUSED (the route then replays the
    // first adjustment with findAdjustmentByImportKey), it does not hand the first one back as if it were new
    if (
      db.all('SELECT 1 AS x FROM stock_adjustments WHERE store_id = ? AND import_key = ?', [
        storeId,
        a.importKey,
      ]).length > 0
    )
      fail('IMPORT_KEY_EXISTS', 'import key already used for this store', 409);
  }
  assertOwns(db, storeId, {
    productIds: a.items.map(i => i.productId),
    variantIds: a.items.flatMap(i => (i.variantId ? [i.variantId] : [])),
  });
  const now = Date.now();
  const adjustmentNumber = nextSequence(db, storeId, 'adjustment', now);
  const snapshots = a.items.map(item => {
    const row = item.variantId
      ? db.all(
          'SELECT v.inventory AS inventory, v.cost_price AS cost_price FROM product_variants v JOIN products p ON p.id = v.product_id WHERE v.id = ? AND v.product_id = ? AND p.store_id = ?',
          [item.variantId, item.productId, storeId]
        )[0]
      : db.all('SELECT inventory, cost_price FROM products WHERE id = ? AND store_id = ?', [
          item.productId,
          storeId,
        ])[0];
    const previousQty = (row?.inventory as number | undefined) ?? 0;
    const unitCost = (row?.cost_price as number | null | undefined) ?? 0;
    const deltaQty = item.countDelta ?? item.newQty - previousQty;
    return { ...item, newQty: previousQty + deltaQty, previousQty, unitCost, deltaQty };
  });
  const totalValueImpact = snapshots.reduce((s, x) => s + x.deltaQty * x.unitCost, 0);
  const id = crypto.randomUUID();
  db.run(
    `INSERT INTO stock_adjustments (id, store_id, adjustment_number, type, status, reason, reason_ar, evidence_url, total_value_impact, created_by, import_key, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      storeId,
      adjustmentNumber,
      a.type,
      a.reason,
      a.reasonAr,
      a.evidenceUrl,
      totalValueImpact,
      a.createdBy,
      a.importKey,
      now,
      now,
    ]
  );
  for (const s of snapshots)
    db.run(
      'INSERT INTO stock_adjustment_items (id, adjustment_id, product_id, variant_id, previous_qty, new_qty, delta_qty, unit_cost, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [
        crypto.randomUUID(),
        id,
        s.productId,
        s.variantId,
        s.previousQty,
        s.newQty,
        s.deltaQty,
        s.unitCost,
        now,
      ]
    );
  return { id, adjustmentNumber, status: 'draft', itemCount: snapshots.length };
}

/** postAdjustment: claim the draft, write each line's absolute quantity, the history rows and the warehouse shadow. */
function postAdjustmentIn(
  db: SyncSql,
  storeId: string,
  id: string,
  postedBy: string | null
): { id: string; status: string } {
  const adj = db.all(
    'SELECT id, status, type, reason, adjustment_number FROM stock_adjustments WHERE id = ? AND store_id = ?',
    [id, storeId]
  )[0];
  if (!adj) return fail('NOT_FOUND', 'Stock adjustment not found', 404);
  if (adj.status !== 'draft')
    return fail('ALREADY_POSTED', 'This stock adjustment has already been posted', 409);
  const now = Date.now();
  // the claim first: the status check above and this update are one section, so a second post finds 'posted'
  db.run(
    "UPDATE stock_adjustments SET status = 'posted', posted_at = ?, posted_by = ?, updated_at = ? WHERE id = ? AND store_id = ? AND status = 'draft'",
    [now, postedBy, now, id, storeId]
  );
  const items = db.all(
    'SELECT product_id, variant_id, previous_qty, new_qty, delta_qty FROM stock_adjustment_items WHERE adjustment_id = ? ORDER BY rowid ASC',
    [id]
  );
  // INV-AUDIT-1: the draft's `previous_qty`/`new_qty` are a snapshot from when it was created, possibly hours ago. What the
  // merchant decided is the DELTA; it is applied to the LIVE quantity (read here, inside the single-writer section), so units
  // sold since the draft stay sold, and the ledger row records the live before/after.
  const applied: { previous: number; next: number }[] = [];
  for (const item of items) {
    const delta = item.delta_qty as number;
    const live = item.variant_id
      ? db.all(
          'SELECT v.inventory AS inventory FROM product_variants v JOIN products p ON p.id = v.product_id WHERE v.id = ? AND p.store_id = ?',
          [item.variant_id, storeId]
        )[0]
      : db.all('SELECT inventory FROM products WHERE id = ? AND store_id = ?', [
          item.product_id,
          storeId,
        ])[0];
    if (!live) notFound();
    const previous = live.inventory as number;
    const next = previous + delta;
    if (next < 0)
      fail(
        'STALE_SNAPSHOT',
        `Stock changed since this adjustment was drafted: live ${previous}, change ${delta} would go below zero. المخزون اتغيّر من وقت ما جهّزت التسوية، والتغيير ده هيخلّي الكمية أقل من صفر. اعمل تسوية جديدة على الكمية الحالية.`,
        409
      );
    const changed = item.variant_id
      ? db.run(
          'UPDATE product_variants SET inventory = ?, updated_at = ? WHERE id = ? AND EXISTS (SELECT 1 FROM products p WHERE p.id = product_variants.product_id AND p.store_id = ?)',
          [next, now, item.variant_id, storeId]
        ).changes
      : db.run('UPDATE products SET inventory = ?, updated_at = ? WHERE id = ? AND store_id = ?', [
          next,
          now,
          item.product_id,
          storeId,
        ]).changes;
    if (changed !== 1) notFound();
    applied.push({ previous, next });
  }
  items.forEach((item, i) =>
    history(db, {
      storeId,
      productId: item.product_id as string,
      type: INVENTORY_TYPE[adj.type as string],
      quantity: item.delta_qty as number,
      previousStock: applied[i].previous,
      newStock: applied[i].next,
      reason: (adj.reason as string | null) ?? (adj.type as string),
      reference: adj.adjustment_number as string,
      createdBy: postedBy,
    })
  );
  const hasWarehouses =
    (db.all('SELECT count(*) AS n FROM warehouses WHERE store_id = ?', [storeId])[0].n as number) >
    0;
  if (hasWarehouses)
    for (const item of items)
      reconcileToAggregate(
        db,
        storeId,
        item.product_id as string,
        (item.variant_id as string | null) ?? null
      );
  return { id, status: 'posted' };
}

const adjItems = (v: unknown): AdjItem[] =>
  list(v, 'items').map(i => ({
    productId: str(i.productId, 'productId'),
    variantId:
      i.variantId === undefined || i.variantId === null ? null : str(i.variantId, 'variantId'),
    newQty: int(i.newQty, 'newQty'),
  }));

export function createStockAdjustment(db: SyncSql, storeId: string, a: Args) {
  return createAdjustmentIn(db, storeId, {
    type: str(a.type, 'type'),
    reason: optStr(a.reason, 'reason'),
    reasonAr: optStr(a.reasonAr, 'reasonAr'),
    evidenceUrl: optStr(a.evidenceUrl, 'evidenceUrl'),
    createdBy: optStr(a.createdBy, 'createdBy', 128),
    importKey: optStr(a.importKey, 'importKey', 128),
    items: adjItems(a.items),
  });
}

export function postStockAdjustment(db: SyncSql, storeId: string, a: Args) {
  return postAdjustmentIn(db, storeId, str(a.id, 'id'), optStr(a.postedBy, 'postedBy', 128));
}

// ---------------------------------------------------------------------------------------------------------------------
// Purchase orders
// ---------------------------------------------------------------------------------------------------------------------

export function createPurchaseOrder(db: SyncSql, storeId: string, a: Args) {
  const supplierId = str(a.supplierId, 'supplierId');
  const items = list(a.items, 'items').map(i => ({
    productId: str(i.productId, 'productId'),
    variantId:
      i.variantId === undefined || i.variantId === null ? null : str(i.variantId, 'variantId'),
    qty: int(i.qty, 'qty', 1),
    unitCost: int(i.unitCost, 'unitCost', 0),
    notes: optStr(i.notes, 'notes'),
  }));
  if (items.length === 0) fail('BAD_ARGS', 'items');
  assertOwns(db, storeId, {
    productIds: items.map(i => i.productId),
    variantIds: items.flatMap(i => (i.variantId ? [i.variantId] : [])),
    supplierIds: [supplierId],
  });
  // Issue 2145: a disabled variant is not stock
  const variantIds = [...new Set(items.flatMap(i => (i.variantId ? [i.variantId] : [])))];
  if (
    variantIds.length &&
    (db.all(
      `SELECT count(*) AS n FROM product_variants WHERE is_active = 0 AND id IN (${inList(variantIds.length)})`,
      variantIds
    )[0].n as number) > 0
  )
    fail(
      'VARIANT_INACTIVE',
      'A variant on this purchase order is disabled. Re-enable it before ordering or receiving stock for it.',
      409
    );
  // owner decision 2026-10-01: a line names the row that holds the stock
  const productIds = [...new Set(items.map(i => i.productId))];
  const variants = db.all(
    `SELECT id, product_id FROM product_variants WHERE product_id IN (${inList(productIds.length)})`,
    productIds
  );
  const variantOwner = new Map(variants.map(v => [v.id as string, v.product_id as string]));
  const variantProducts = new Set(variants.map(v => v.product_id as string));
  for (const i of items) {
    if (i.variantId) {
      if (variantOwner.get(i.variantId) !== i.productId)
        fail(
          'VARIANT_PRODUCT_MISMATCH',
          'A purchase order line names a variant that does not belong to its product.'
        );
    } else if (variantProducts.has(i.productId))
      fail(
        'VARIANT_REQUIRED',
        'This product has variants — choose the variant for each purchase order line.'
      );
  }
  const now = Date.now();
  const subtotal = items.reduce((s, i) => s + i.qty * i.unitCost, 0);
  const apAccountId = systemAccountId(db, storeId, '2000');
  const poNumber = nextSequence(db, storeId, 'po', now);
  const id = crypto.randomUUID();
  db.run(
    `INSERT INTO purchase_orders (id, store_id, supplier_id, po_number, status, expected_date, subtotal, total, ap_account_id, notes, notes_ar, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      storeId,
      supplierId,
      poNumber,
      optMs(a.expectedDate, 'expectedDate'),
      subtotal,
      subtotal,
      apAccountId,
      optStr(a.notes, 'notes'),
      optStr(a.notesAr, 'notesAr'),
      optStr(a.createdBy, 'createdBy', 128),
      now,
      now,
    ]
  );
  for (const i of items)
    db.run(
      'INSERT INTO purchase_order_items (id, po_id, product_id, variant_id, qty, unit_cost, total, notes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [
        crypto.randomUUID(),
        id,
        i.productId,
        i.variantId,
        i.qty,
        i.unitCost,
        i.qty * i.unitCost,
        i.notes,
        now,
      ]
    );
  if (a.suggestionId !== undefined && a.suggestionId !== null) {
    // createPoFromSuggestion: the PO and the suggestion's `accepted` + poId land together
    const r = db.run(
      "UPDATE reorder_suggestions SET status = 'accepted', po_id = ? WHERE id = ? AND store_id = ? AND status = 'open'",
      [id, str(a.suggestionId, 'suggestionId'), storeId]
    );
    if (r.changes !== 1)
      fail('SUGGESTION_ALREADY_PROCESSED', 'This reorder suggestion was already processed.', 409);
  }
  return { id, poNumber };
}

export function cancelPurchaseOrder(db: SyncSql, storeId: string, a: Args) {
  const id = str(a.id, 'id');
  const po = db.all('SELECT id FROM purchase_orders WHERE id = ? AND store_id = ?', [
    id,
    storeId,
  ])[0];
  if (!po) return fail('PO_NOT_FOUND', 'Purchase order not found.', 404);
  // a fully received PO (stock and accounts payable posted) is never overwritten to cancelled
  const r = db.run(
    "UPDATE purchase_orders SET status = 'cancelled', updated_at = ? WHERE id = ? AND store_id = ? AND status <> 'received'",
    [Date.now(), id, storeId]
  );
  if (r.changes !== 1)
    fail('PO_ALREADY_RECEIVED', 'A fully-received purchase order cannot be cancelled.', 409);
  return { id, status: 'cancelled' };
}

interface Cleared {
  backorderLineId: string;
  orderItemId: string;
  qty: number;
  actualUnitCost: number;
  estimateUnitCost: number;
  variance: number;
}

/** healBackorderStockDebt: a non-variant, tracked product with negative stock gets min(units, debt) back, never above 0. */
function healBackorderStockDebt(
  db: SyncSql,
  a: {
    storeId: string;
    productId: string;
    variantId: string | null;
    quantity: number;
    reference: string;
    reason: string;
    userId: string | null;
  }
): number {
  if (a.variantId || a.quantity <= 0) return 0;
  const row = db.all(
    'SELECT inventory, track_inventory FROM products WHERE id = ? AND store_id = ?',
    [a.productId, a.storeId]
  )[0];
  if (!row || !row.track_inventory || (row.inventory as number) >= 0) return 0;
  const inv = row.inventory as number;
  const healed = Math.min(a.quantity, -inv);
  db.run('UPDATE products SET inventory = inventory + ? WHERE id = ? AND store_id = ?', [
    healed,
    a.productId,
    a.storeId,
  ]);
  history(db, {
    storeId: a.storeId,
    productId: a.productId,
    type: 'return_stock',
    quantity: healed,
    previousStock: inv,
    newStock: inv + healed,
    reason: a.reason,
    reference: a.reference,
    createdBy: a.userId,
  });
  return healed;
}

/** receivePurchaseOrder: FIFO-clear backorders, replenish on hand with a weighted-average cost, move the PO status. */
export function receivePurchaseOrder(db: SyncSql, storeId: string, a: Args) {
  const poId = str(a.poId, 'poId');
  const receivedBy = optStr(a.receivedBy, 'receivedBy', 128);
  const receipts = list(a.receipts, 'receipts').map(r => ({
    poItemId: str(r.poItemId, 'poItemId'),
    qtyReceived: int(r.qtyReceived, 'qtyReceived'),
  }));
  const now = Date.now();
  const po = db.all(
    'SELECT id, po_number, status, received_at, received_by FROM purchase_orders WHERE id = ? AND store_id = ?',
    [poId, storeId]
  )[0];
  if (!po) return fail('PO_NOT_FOUND', 'Purchase order not found.', 404);
  if (po.status === 'received' || po.status === 'cancelled')
    fail(
      'PO_NOT_RECEIVABLE',
      `This purchase order can no longer be received (status: ${po.status}).`,
      409
    );
  const poItems = db.all(
    'SELECT id, product_id, variant_id, qty, qty_received, unit_cost FROM purchase_order_items WHERE po_id = ?',
    [poId]
  );
  const cleared: Cleared[] = [];
  for (const receipt of receipts) {
    if (receipt.qtyReceived <= 0) continue;
    const item = poItems.find(i => i.id === receipt.poItemId);
    if (!item) return fail('PO_ITEM_NOT_FOUND', 'A receipt line does not match this PO.');
    const productId = item.product_id as string;
    const variantId = (item.variant_id as string | null) ?? null;
    const unitCost = item.unit_cost as number;
    // the live row, not the snapshot taken above: two receipts of one item in ONE call see each other
    const qtyReceivedNow = db.all('SELECT qty_received FROM purchase_order_items WHERE id = ?', [
      item.id,
    ])[0].qty_received as number;
    const remainingAfter = qtyReceivedNow + receipt.qtyReceived;
    if (remainingAfter > (item.qty as number))
      fail(
        'RECEIVE_EXCEEDS_QTY',
        `Cannot receive ${receipt.qtyReceived}; that would exceed the ordered quantity (${item.qty}).`
      );
    if (
      !variantId &&
      (db.all('SELECT count(*) AS n FROM product_variants WHERE product_id = ?', [productId])[0]
        .n as number) > 0
    )
      fail(
        'VARIANT_REQUIRED',
        'This line has no variant but its product has variants. Cancel this purchase order and draft it again per variant.'
      );

    let remaining = receipt.qtyReceived;
    const openBackorders = db.all(
      `SELECT bo.id, bo.order_item_id, bo.qty, bo.qty_fulfilled, oi.cost_price AS estimate
         FROM backorder_lines bo JOIN order_items oi ON oi.id = bo.order_item_id
        WHERE bo.store_id = ? AND bo.product_id = ? AND bo.variant_id ${variantId ? '= ?' : 'IS NULL'}
          AND bo.fulfilled_at IS NULL AND bo.cancelled_at IS NULL
        ORDER BY bo.created_at ASC, bo.rowid ASC`,
      variantId ? [storeId, productId, variantId] : [storeId, productId]
    );
    for (const bo of openBackorders) {
      if (remaining <= 0) break;
      const stillNeeded = (bo.qty as number) - (bo.qty_fulfilled as number);
      const fulfilQty = Math.min(stillNeeded, remaining);
      const newFulfilled = (bo.qty_fulfilled as number) + fulfilQty;
      const full = newFulfilled === bo.qty;
      db.run(
        `UPDATE backorder_lines SET qty_fulfilled = ?${full ? ', fulfilled_at = ?, fulfilled_by_po_item_id = ?' : ''} WHERE id = ? AND store_id = ?`,
        full ? [newFulfilled, now, item.id, bo.id, storeId] : [newFulfilled, bo.id, storeId]
      );
      healBackorderStockDebt(db, {
        storeId,
        productId,
        variantId,
        quantity: fulfilQty,
        reference: `po-backorder:${bo.id}`,
        reason: `PO receive ${po.po_number} — backorder fulfilled, stock debt healed to 0`,
        userId: receivedBy,
      });
      const estimate = (bo.estimate as number | null) ?? 0;
      cleared.push({
        backorderLineId: bo.id as string,
        orderItemId: bo.order_item_id as string,
        qty: fulfilQty,
        actualUnitCost: unitCost,
        estimateUnitCost: estimate,
        variance: (unitCost - estimate) * fulfilQty,
      });
      if (full) {
        const open = db.all(
          'SELECT count(*) AS n FROM backorder_lines WHERE store_id = ? AND order_item_id = ? AND fulfilled_at IS NULL AND cancelled_at IS NULL AND id <> ?',
          [storeId, bo.order_item_id, bo.id]
        )[0].n as number;
        if (open === 0)
          db.run(
            'UPDATE order_items SET cost_price_deferred = 0 WHERE id = ? AND EXISTS (SELECT 1 FROM orders o WHERE o.id = order_items.order_id AND o.store_id = ?)',
            [bo.order_item_id, storeId]
          );
      }
      remaining -= fulfilQty;
    }

    if (remaining > 0) {
      const product = db.all(
        'SELECT inventory, cost_price FROM products WHERE id = ? AND store_id = ?',
        [productId, storeId]
      )[0];
      if (!product) return fail('PRODUCT_NOT_FOUND', `Product ${productId} not found`, 404);
      const variantRows = db.all(
        'SELECT inventory, is_active FROM product_variants WHERE product_id = ?',
        [productId]
      );
      // effectiveInventory: the sum of ACTIVE variants for a variant product, else the product's own column
      const onHandBefore =
        variantRows.length === 0
          ? (product.inventory as number)
          : variantRows
              .filter(v => v.is_active !== 0)
              .reduce((s, v) => s + ((v.inventory as number) ?? 0), 0);
      if (variantId) {
        const variant = db.all(
          'SELECT inventory, cost_price, is_active FROM product_variants WHERE id = ? AND product_id = ?',
          [variantId, productId]
        )[0];
        if (!variant)
          return fail('VARIANT_NOT_FOUND', `Variant ${variantId} not found in store`, 404);
        if (variant.is_active === 0)
          fail(
            'VARIANT_INACTIVE',
            'A variant on this purchase order is disabled. Re-enable it before receiving stock for it.',
            409
          );
        const vOldStock = Math.max(variant.inventory as number, 0);
        const vOldCost =
          (variant.cost_price as number | null) ??
          (product.cost_price as number | null) ??
          unitCost;
        const denom = vOldStock + remaining;
        const vNewCost =
          denom > 0 ? Math.round((vOldStock * vOldCost + remaining * unitCost) / denom) : unitCost;
        db.run(
          'UPDATE product_variants SET inventory = inventory + ?, cost_price = ?, updated_at = ? WHERE id = ?',
          [remaining, vNewCost, now, variantId]
        );
        db.run('UPDATE products SET last_cost_update_at = ? WHERE id = ? AND store_id = ?', [
          now,
          productId,
          storeId,
        ]);
      } else {
        const oldStock = Math.max(onHandBefore, 0);
        const oldCost = (product.cost_price as number | null) ?? unitCost;
        const denom = oldStock + remaining;
        const newCost =
          denom > 0 ? Math.round((oldStock * oldCost + remaining * unitCost) / denom) : unitCost;
        // a relative write, like Postgres: an absolute `onHandBefore + n` would overwrite a sale in between
        db.run(
          'UPDATE products SET inventory = inventory + ?, cost_price = ?, last_cost_update_at = ?, updated_at = ? WHERE id = ? AND store_id = ?',
          [remaining, newCost, now, now, productId, storeId]
        );
      }
      history(db, {
        storeId,
        productId,
        type: 'transfer_in',
        quantity: remaining,
        previousStock: onHandBefore,
        newStock: onHandBefore + remaining,
        reason: `PO receive ${po.po_number}`,
        reference: item.id as string,
        createdBy: null,
      });
    }
    db.run('UPDATE purchase_order_items SET qty_received = ? WHERE id = ?', [
      remainingAfter,
      item.id,
    ]);
  }
  const updated = db.all('SELECT qty, qty_received FROM purchase_order_items WHERE po_id = ?', [
    poId,
  ]);
  const allComplete = updated.every(i => i.qty_received === i.qty);
  const anyReceived = updated.some(i => (i.qty_received as number) > 0);
  const status = allComplete ? 'received' : anyReceived ? 'partial' : (po.status as string);
  db.run(
    'UPDATE purchase_orders SET status = ?, received_at = ?, received_by = ?, updated_at = ? WHERE id = ? AND store_id = ?',
    [
      status,
      allComplete ? now : ((po.received_at as number | null) ?? null),
      receivedBy ?? (po.received_by as string | null) ?? null,
      now,
      poId,
      storeId,
    ]
  );
  return { poId, status, clearedBackorders: cleared };
}

// ---------------------------------------------------------------------------------------------------------------------
// Opening balance (account.service.ts postOpeningBalanceIfNeeded) and the chart seed it follows
// ---------------------------------------------------------------------------------------------------------------------

/**
 * seedCoaForStore on the DO: insert the system accounts the store is missing (the template rows come from the caller, which
 * owns `COA_TEMPLATE`), then post the one-time opening-balance journal. Idempotent: existing codes are left alone and the
 * journal is keyed `(opening_balance, storeId)`.
 */
export function seedCoa(db: SyncSql, storeId: string, a: Args) {
  const rows = list(a.accounts, 'accounts', 500).map(r => ({
    code: str(r.code, 'code'),
    nameEn: str(r.nameEn, 'nameEn'),
    nameAr: optStr(r.nameAr, 'nameAr', 256),
    type: str(r.type, 'type'),
  }));
  const have = new Set(
    db
      .all('SELECT code FROM accounts WHERE store_id = ? AND is_system = 1', [storeId])
      .map(r => r.code as string)
  );
  const now = Date.now();
  let created = 0;
  for (const r of rows) {
    if (have.has(r.code)) continue;
    db.run(
      'INSERT INTO accounts (id, store_id, code, name_en, name_ar, type, is_system, is_active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 1, 1, ?, ?)',
      [crypto.randomUUID(), storeId, r.code, r.nameEn, r.nameAr, r.type, now, now]
    );
    created++;
  }
  return { created, opening: openingBalance(db, storeId) };
}

export function openingBalance(
  db: SyncSql,
  storeId: string
): { posted: boolean; total: number; skus: number } {
  const products = db.all(
    `SELECT inventory, cost_price FROM products WHERE store_id = ? AND deleted_at IS NULL AND status <> 'archived'
        AND track_inventory = 1 AND has_variants = 0 AND cost_price IS NOT NULL AND cost_price > 0 AND inventory > 0`,
    [storeId]
  );
  const variants = db.all(
    `SELECT v.inventory AS inventory, v.cost_price AS cost_price, p.cost_price AS parent_cost
       FROM product_variants v JOIN products p ON p.id = v.product_id
      WHERE p.store_id = ? AND p.deleted_at IS NULL AND p.status <> 'archived' AND p.track_inventory = 1
        AND v.is_active = 1 AND v.inventory > 0`,
    [storeId]
  );
  const total =
    products.reduce((s, p) => s + (p.inventory as number) * ((p.cost_price as number) ?? 0), 0) +
    variants.reduce(
      (s, v) =>
        s +
        (v.inventory as number) *
          ((v.cost_price as number | null) ?? (v.parent_cost as number | null) ?? 0),
      0
    );
  const skus = products.length + variants.length;
  if (total <= 0) return { posted: false, total: 0, skus };
  const inventoryAccountId = systemAccountId(db, storeId, '1200');
  const equityAccountId = systemAccountId(db, storeId, '3000');
  const r = postEntry(db, {
    storeId,
    source: 'opening_balance',
    sourceId: storeId, // one opening-balance entry per store, ever
    memo: 'Opening balance — inventory carried forward',
    memoAr: 'الرصيد الافتتاحي — المخزون المُرحَّل',
    lines: [
      {
        accountId: inventoryAccountId,
        debit: total,
        credit: 0,
        lineMemo: `Opening inventory value (${skus} SKUs)`,
        refTable: 'stores',
        refId: storeId,
      },
      {
        accountId: equityAccountId,
        debit: 0,
        credit: total,
        lineMemo: 'Equity contra-entry for opening inventory',
        refTable: 'stores',
        refId: storeId,
      },
    ],
  });
  return { posted: r.created, total, skus };
}

export function openingBalanceOp(db: SyncSql, storeId: string, _a: Args) {
  return openingBalance(db, storeId);
}

// ---------------------------------------------------------------------------------------------------------------------
// Scan flows: variant receive, count sessions
// ---------------------------------------------------------------------------------------------------------------------

/** receiveByBarcode for a VARIANT barcode: its inventory moves and the history row is written, both or neither. */
export function receiveVariant(db: SyncSql, storeId: string, a: Args) {
  const productId = str(a.productId, 'productId');
  const variantId = str(a.variantId, 'variantId');
  const quantity = int(a.quantity, 'quantity', 1);
  const v = db.all(
    'SELECT v.inventory AS inventory FROM product_variants v JOIN products p ON p.id = v.product_id WHERE v.id = ? AND v.product_id = ? AND p.store_id = ?',
    [variantId, productId, storeId]
  )[0];
  if (!v) return fail('VARIANT_NOT_FOUND', 'Variant not found', 404);
  const previousInventory = v.inventory as number;
  const newInventory = previousInventory + quantity;
  if (newInventory > INT4_MAX) fail('BAD_ARGS', 'stock overflow');
  db.run('UPDATE product_variants SET inventory = ?, updated_at = ? WHERE id = ?', [
    newInventory,
    Date.now(),
    variantId,
  ]);
  history(db, {
    storeId,
    productId,
    type: 'manual_add',
    quantity,
    previousStock: previousInventory,
    newStock: newInventory,
    reason: optStr(a.reason, 'reason') ?? 'barcode_receive',
    reference: optStr(a.reference, 'reference'),
    createdBy: optStr(a.userId, 'userId', 128),
  });
  return { productId, variantId, previousInventory, newInventory, qtyReceived: quantity };
}

/**
 * pickOrderItemByBarcode (scan-to-pick) on a DO store (Ruling NZ-FEAT-1). The Postgres twin is a conditional UPDATE under a row
 * lock; here the whole read-check-write is one section: the first line of this order for the product (+ variant) still short of
 * its quantity takes the units, capped at its quantity, `picked_at` set when it is full. Two scanners can never push a line past
 * its quantity. `not_in_order` / `already_picked` are answers (the service turns them into its 409s), nothing is written.
 */
export function pickOrderItem(db: SyncSql, storeId: string, a: Args) {
  const orderId = str(a.orderId, 'orderId');
  const productId = str(a.productId, 'productId');
  const variantId = a.variantId == null ? null : str(a.variantId, 'variantId');
  const qty = int(a.qty, 'qty', 1);
  const candidates = db.all(
    `SELECT oi.id, oi.order_id, oi.product_id, oi.variant_id, oi.product_name, oi.personalisation, oi.quantity, oi.picked_qty
       FROM order_items oi JOIN orders o ON o.id = oi.order_id
      WHERE oi.order_id = ? AND o.store_id = ? AND oi.product_id = ?${variantId ? ' AND oi.variant_id = ?' : ''}
      ORDER BY oi.id ASC`,
    variantId ? [orderId, storeId, productId, variantId] : [orderId, storeId, productId]
  );
  if (candidates.length === 0) return { kind: 'not_in_order' as const };
  const line = candidates.find(c => (c.picked_qty as number) < (c.quantity as number));
  if (!line) return { kind: 'already_picked' as const };
  const before = line.picked_qty as number;
  const quantity = line.quantity as number;
  const after = Math.min(before + qty, quantity);
  db.run('UPDATE order_items SET picked_qty = ?, picked_at = ? WHERE id = ?', [
    after,
    after >= quantity ? Date.now() : null,
    line.id,
  ]);
  const remaining = db.all(
    'SELECT COUNT(*) AS n FROM order_items WHERE order_id = ? AND picked_qty < quantity',
    [orderId]
  )[0];
  return {
    kind: 'picked' as const,
    item: {
      id: line.id as string,
      orderId: line.order_id as string,
      productId: line.product_id as string,
      variantId: (line.variant_id as string | null) ?? null,
      productName: line.product_name as string,
      personalisation: (line.personalisation as string | null) ?? null,
      quantity,
    },
    pickedQtyBefore: before,
    pickedQtyAfter: after,
    orderFullyPicked: Number(remaining?.n ?? 0) === 0,
  };
}

const sessionRow = (db: SyncSql, storeId: string, id: string): Row | undefined =>
  db.all('SELECT id, status FROM count_sessions WHERE id = ? AND store_id = ?', [id, storeId])[0];

export function openCountSession(db: SyncSql, storeId: string, a: Args) {
  const id = crypto.randomUUID();
  const now = Date.now();
  db.run(
    "INSERT INTO count_sessions (id, store_id, status, note, created_by, created_at, updated_at) VALUES (?, ?, 'open', ?, ?, ?, ?)",
    [id, storeId, optStr(a.note, 'note'), optStr(a.createdBy, 'createdBy', 128), now, now]
  );
  return { id, storeId, status: 'open', note: optStr(a.note, 'note'), createdAt: new Date(now) };
}

/** submitCountLine: snapshot the system quantity, upsert the line for (session, product, variant). */
export function submitCountLine(db: SyncSql, storeId: string, a: Args) {
  const sessionId = str(a.sessionId, 'sessionId');
  const productId = str(a.productId, 'productId');
  const variantId =
    a.variantId === undefined || a.variantId === null ? null : str(a.variantId, 'variantId');
  const countedQty = int(a.countedQty, 'countedQty', 0);
  const s = sessionRow(db, storeId, sessionId);
  if (!s || s.status !== 'open')
    return fail('SESSION_NOT_FOUND', 'Count session not found or not open', 404);
  const sys = variantId
    ? db.all('SELECT inventory FROM product_variants WHERE id = ? AND product_id = ?', [
        variantId,
        productId,
      ])[0]
    : db.all(
        'SELECT inventory FROM products WHERE id = ? AND store_id = ? AND deleted_at IS NULL',
        [productId, storeId]
      )[0];
  const systemQty = (sys?.inventory as number | undefined) ?? 0;
  const variance = countedQty - systemQty;
  const now = Date.now();
  const existing = db.all(
    `SELECT id FROM count_lines WHERE session_id = ? AND product_id = ? AND variant_id ${variantId ? '= ?' : 'IS NULL'}`,
    variantId ? [sessionId, productId, variantId] : [sessionId, productId]
  )[0];
  if (existing) {
    db.run(
      'UPDATE count_lines SET counted_qty = ?, system_qty = ?, variance = ?, scanned_at = ? WHERE id = ?',
      [countedQty, systemQty, variance, now, existing.id]
    );
    return {
      id: existing.id as string,
      sessionId,
      productId,
      variantId,
      countedQty,
      systemQty,
      variance,
    };
  }
  const id = crypto.randomUUID();
  db.run(
    'INSERT INTO count_lines (id, session_id, product_id, variant_id, counted_qty, system_qty, variance, scanned_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [id, sessionId, productId, variantId, countedQty, systemQty, variance, now]
  );
  return { id, sessionId, productId, variantId, countedQty, systemQty, variance };
}

export function closeCountSession(db: SyncSql, storeId: string, a: Args) {
  const id = str(a.sessionId, 'sessionId');
  const s = sessionRow(db, storeId, id);
  if (!s) return fail('SESSION_NOT_FOUND', 'Session not found', 404);
  if (s.status !== 'open') fail('SESSION_NOT_OPEN', 'Session is not open', 409);
  const now = Date.now();
  db.run(
    "UPDATE count_sessions SET status = 'closed', closed_at = ?, updated_at = ? WHERE id = ? AND store_id = ?",
    [now, now, id, storeId]
  );
  return { id, status: 'closed', closedAt: new Date(now) };
}

/** reconcileCountSession: a cycle_count adjustment for every non-zero variance, posted at once, the session marked. */
export function reconcileCountSession(db: SyncSql, storeId: string, a: Args) {
  const id = str(a.sessionId, 'sessionId');
  const reconciledBy = optStr(a.reconciledBy, 'reconciledBy', 128);
  const s = sessionRow(db, storeId, id);
  if (!s || s.status !== 'closed')
    return fail('SESSION_NOT_FOUND', 'Session not found or not closed', 404);
  const lines = db.all(
    'SELECT product_id, variant_id, counted_qty, variance FROM count_lines WHERE session_id = ? ORDER BY rowid ASC',
    [id]
  );
  const nonZero = lines.filter(l => l.variance !== 0);
  const zeroVarianceLines = lines.length - nonZero.length;
  let adjustmentId: string | null = null;
  if (nonZero.length > 0) {
    const adj = createAdjustmentIn(db, storeId, {
      type: 'cycle_count',
      reason: `Cycle count reconcile — session ${id}`,
      reasonAr: null,
      evidenceUrl: null,
      createdBy: reconciledBy,
      importKey: null,
      items: nonZero.map(l => ({
        productId: l.product_id as string,
        variantId: (l.variant_id as string | null) ?? null,
        newQty: l.counted_qty as number,
        countDelta: l.variance as number,
      })),
    });
    postAdjustmentIn(db, storeId, adj.id, reconciledBy);
    adjustmentId = adj.id;
  }
  const now = Date.now();
  db.run(
    "UPDATE count_sessions SET status = 'reconciled', reconciled_at = ?, adjustment_id = COALESCE(?, adjustment_id), updated_at = ? WHERE id = ? AND store_id = ?",
    [now, adjustmentId, now, id, storeId]
  );
  return { adjustmentId, linesReconciled: nonZero.length, zeroVarianceLines };
}

// ---------------------------------------------------------------------------------------------------------------------
// Product bulk update, inventory field
// ---------------------------------------------------------------------------------------------------------------------

/**
 * ProductService.bulkUpdate `fields.inventory`: simple (variant-less) products only, absolute or relative, floored at 0.
 * Every change writes a movement row (INV-AUDIT-3: reason + actor; opening stock passes type 'initial'); it writes no warehouse
 * shadow (the daily reconcile heals that, P2-6). A write that changes nothing writes no row.
 */
export function bulkSetInventory(db: SyncSql, storeId: string, a: Args) {
  if (!Array.isArray(a.productIds) || a.productIds.length > 500) fail('BAD_ARGS', 'productIds');
  const productIds = [...new Set((a.productIds as unknown[]).map(x => str(x, 'productId')))];
  const mode = a.mode === 'set' || a.mode === 'adjust' ? a.mode : fail('BAD_ARGS', 'mode');
  if (typeof a.value !== 'number' || !Number.isFinite(a.value)) fail('BAD_ARGS', 'value');
  const value = Math.round(a.value as number);
  const type =
    a.type === undefined
      ? 'adjustment'
      : a.type === 'initial'
        ? 'initial'
        : fail('BAD_ARGS', 'type');
  const reason = optStr(a.reason, 'reason') ?? 'Bulk inventory update';
  const createdBy = optStr(a.userId, 'userId', 128);
  const now = Date.now();
  const rows = productIds.length
    ? db.all(
        `SELECT p.id, p.inventory FROM products p WHERE p.store_id = ? AND p.deleted_at IS NULL
           AND NOT EXISTS (SELECT 1 FROM product_variants v WHERE v.product_id = p.id) AND p.id IN (${inList(productIds.length)})`,
        [storeId, ...productIds]
      )
    : [];
  for (const r of rows) {
    const next = mode === 'set' ? Math.max(0, value) : Math.max(0, (r.inventory as number) + value);
    if (next > INT4_MAX) fail('BAD_ARGS', 'stock overflow');
    db.run('UPDATE products SET inventory = ?, updated_at = ? WHERE id = ? AND store_id = ?', [
      next,
      now,
      r.id,
      storeId,
    ]);
    if (next !== (r.inventory as number))
      history(db, {
        storeId,
        productId: r.id as string,
        type,
        quantity: next - (r.inventory as number),
        previousStock: r.inventory as number,
        newStock: next,
        reason,
        reference: null,
        createdBy,
      });
  }
  return { updated: rows.length };
}

// ---------------------------------------------------------------------------------------------------------------------
// COD settlement import (Ruling CF-R7-2)
// ---------------------------------------------------------------------------------------------------------------------

/**
 * CodReconciliationService.importSettlement for a store on its DO. The remittance LINES live with the store (the DO's
 * `cod_remittances`, whose `shipment_id` references the DO's own `shipments`), so a line can reference a DO store's shipment;
 * on Postgres that FK pointed at Postgres `shipments`, which a DO store never writes. One section: the shipments are matched
 * (carrier + tracking number, the newest shipment wins a tie) and the lines inserted together, so a line never carries a
 * shipment id that is not in this store. Idempotent per `(store, carrier, lineRef)`: a line already imported is a duplicate and
 * changes nothing, so the same statement imported twice (or two uploads racing) books every amount once.
 */
export function importCodRemittances(db: SyncSql, storeId: string, a: Args) {
  const carrier = str(a.carrier, 'carrier');
  const source = optStr(a.source, 'source', 32) ?? 'csv';
  const rows = list(a.rows, 'rows', 5000).map(r => {
    const gross = int(r.grossAmount, 'grossAmount', 0);
    const fee = int(r.feeAmount, 'feeAmount', 0);
    const net = int(r.netAmount, 'netAmount', 0);
    // the table's own CHECK would refuse it with an opaque constraint error: answer it as a bad row instead
    if (net !== gross - fee) fail('BAD_ARGS', 'netAmount must equal grossAmount - feeAmount');
    return {
      trackingNumber: str(r.trackingNumber, 'trackingNumber'),
      lineRef: str(r.lineRef, 'lineRef'),
      batchId: optStr(r.batchId, 'batchId', 128),
      gross,
      fee,
      net,
      remittedAt: optMs(r.remittedAt, 'remittedAt') ?? fail('BAD_ARGS', 'remittedAt'),
    };
  });
  const trackings = [...new Set(rows.map(r => r.trackingNumber))];
  const byTracking = new Map<string, string>();
  if (trackings.length)
    for (const s of db.all(
      `SELECT id, tracking_number FROM shipments WHERE store_id = ? AND carrier = ? AND tracking_number IN (${inList(trackings.length)}) ORDER BY created_at ASC, rowid ASC`,
      [storeId, carrier, ...trackings]
    ))
      byTracking.set(s.tracking_number as string, s.id as string); // ascending: the newest overwrites
  let inserted = 0;
  const now = Date.now();
  for (const r of rows)
    inserted += db.run(
      `INSERT INTO cod_remittances (id, store_id, shipment_id, carrier, tracking_number, line_ref, batch_id, gross_amount, fee_amount, net_amount, remitted_at, source, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (store_id, carrier, line_ref) DO NOTHING`,
      [
        crypto.randomUUID(),
        storeId,
        byTracking.get(r.trackingNumber) ?? null,
        carrier,
        r.trackingNumber,
        r.lineRef,
        r.batchId,
        r.gross,
        r.fee,
        r.net,
        r.remittedAt,
        source,
        now,
      ]
    ).changes;
  return {
    inserted,
    duplicates: rows.length - inserted,
    unmatched: rows.filter(r => !byTracking.has(r.trackingNumber)).length,
  };
}

export const BOOKS_OPS = {
  createStockAdjustment,
  postStockAdjustment,
  createPurchaseOrder,
  cancelPurchaseOrder,
  receivePurchaseOrder,
  seedCoa,
  openingBalance: openingBalanceOp,
  receiveVariant,
  openCountSession,
  submitCountLine,
  closeCountSession,
  reconcileCountSession,
  bulkSetInventory,
  importCodRemittances,
  pickOrderItem,
} as const;
export type BooksOpName = keyof typeof BOOKS_OPS;
